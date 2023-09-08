// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { type SignedTransaction, type SignedMessage } from '@mysten/sui.js';
import { type SuiTransactionBlockResponse } from '@mysten/sui.js/client';

import { type SerializedSignature, type ExportedKeypair } from '@mysten/sui.js/cryptography';
import { toB64 } from '@mysten/sui.js/utils';
import { type QueryKey } from '@tanstack/react-query';
import { lastValueFrom, map, take } from 'rxjs';

import { growthbook } from '../experimentation/feature-gating';
import { accountsQueryKey } from '../helpers/query-client-keys';
import { queryClient } from '../helpers/queryClient';
import { accountSourcesQueryKey } from '../hooks/useAccountSources';
import { createMessage } from '_messages';
import { PortStream } from '_messaging/PortStream';
import { type BasePayload } from '_payloads';
import { isLoadedFeaturesPayload } from '_payloads/feature-gating';
import { isKeyringPayload } from '_payloads/keyring';
import { isSetNetworkPayload, type SetNetworkPayload } from '_payloads/network';
import { isPermissionRequests } from '_payloads/permissions';
import { isUpdateActiveOrigin } from '_payloads/tabs/updateActiveOrigin';
import { isGetTransactionRequestsResponse } from '_payloads/transactions/ui/GetTransactionRequestsResponse';
import { setActiveOrigin, changeActiveNetwork } from '_redux/slices/app';
import { setPermissions } from '_redux/slices/permissions';
import { setTransactionRequests } from '_redux/slices/transaction-requests';
import { type MnemonicSerializedUiAccount } from '_src/background/accounts/MnemonicAccount';
import {
	type MethodPayload,
	isMethodPayload,
	type UIAccessibleEntityType,
} from '_src/shared/messaging/messages/payloads/MethodPayload';
import {
	isQredoConnectPayload,
	type QredoConnectPayload,
} from '_src/shared/messaging/messages/payloads/QredoConnect';

import type { Message } from '_messages';
import type { KeyringPayload } from '_payloads/keyring';
import type { GetPermissionRequests, PermissionResponse } from '_payloads/permissions';
import type { DisconnectApp } from '_payloads/permissions/DisconnectApp';
import type { GetTransactionRequests } from '_payloads/transactions/ui/GetTransactionRequests';
import type { TransactionRequestResponse } from '_payloads/transactions/ui/TransactionRequestResponse';
import type { NetworkEnvType } from '_src/shared/api-env';
import type { AppDispatch } from '_store';

const entitiesToClientQueryKeys: Record<UIAccessibleEntityType, QueryKey> = {
	accounts: accountsQueryKey,
	accountSources: accountSourcesQueryKey,
};

/**
 * The duration in milliseconds that the UI sends status updates (active/inactive) to the background service.
 * Currently used to postpone auto locking keyring when the app is active.
 */
const APP_STATUS_UPDATE_INTERVAL = 20 * 1000;

export class BackgroundClient {
	private _portStream: PortStream | null = null;
	private _dispatch: AppDispatch | null = null;
	private _initialized = false;

	public init(dispatch: AppDispatch) {
		if (this._initialized) {
			throw new Error('[BackgroundClient] already initialized');
		}
		this._initialized = true;
		this._dispatch = dispatch;
		this.createPortStream();
		this.sendAppStatus();
		this.setupAppStatusUpdateInterval();
		return Promise.all([
			this.sendGetPermissionRequests(),
			this.sendGetTransactionRequests(),
			this.loadFeatures(),
			this.getNetwork(),
		]).then(() => undefined);
	}

	public sendPermissionResponse(
		id: string,
		accounts: string[],
		allowed: boolean,
		responseDate: string,
	) {
		this.sendMessage(
			createMessage<PermissionResponse>({
				id,
				type: 'permission-response',
				accounts,
				allowed,
				responseDate,
			}),
		);
	}

	public sendGetPermissionRequests() {
		return lastValueFrom(
			this.sendMessage(
				createMessage<GetPermissionRequests>({
					type: 'get-permission-requests',
				}),
			).pipe(take(1)),
		);
	}

	public sendTransactionRequestResponse(
		txID: string,
		approved: boolean,
		txResult?: SuiTransactionBlockResponse | SignedMessage,
		txResultError?: string,
		txSigned?: SignedTransaction,
	) {
		this.sendMessage(
			createMessage<TransactionRequestResponse>({
				type: 'transaction-request-response',
				approved,
				txID,
				txResult,
				txResultError,
				txSigned,
			}),
		);
	}

	public sendGetTransactionRequests() {
		return lastValueFrom(
			this.sendMessage(
				createMessage<GetTransactionRequests>({
					type: 'get-transaction-requests',
				}),
			).pipe(take(1)),
		);
	}

	/**
	 * Disconnect a dapp, if specificAccounts contains accounts then only those accounts will be disconnected.
	 * @param origin The origin of the dapp
	 * @param specificAccounts Accounts to disconnect. If not provided or it's an empty array all accounts will be disconnected
	 */
	public async disconnectApp(origin: string, specificAccounts?: string[]) {
		await lastValueFrom(
			this.sendMessage(
				createMessage<DisconnectApp>({
					type: 'disconnect-app',
					origin,
					specificAccounts,
				}),
			).pipe(take(1)),
		);
	}

	public createVault(password: string, importedEntropy?: string) {
		return lastValueFrom(
			this.sendMessage(
				createMessage<KeyringPayload<'create'>>({
					type: 'keyring',
					method: 'create',
					args: { password, importedEntropy },
					return: undefined,
				}),
			).pipe(take(1)),
		);
	}

	public unlockWallet(password: string) {
		return lastValueFrom(
			this.sendMessage(
				createMessage<KeyringPayload<'unlock'>>({
					type: 'keyring',
					method: 'unlock',
					args: { password },
					return: undefined,
				}),
			).pipe(take(1)),
		);
	}

	public lockWallet() {
		return lastValueFrom(
			this.sendMessage(
				createMessage<KeyringPayload<'lock'>>({
					type: 'keyring',
					method: 'lock',
				}),
			).pipe(take(1)),
		);
	}

	public clearWallet() {
		return lastValueFrom(
			this.sendMessage(
				createMessage<MethodPayload<'clearWallet'>>({
					type: 'method-payload',
					method: 'clearWallet',
					args: {},
				}),
			).pipe(take(1)),
		);
	}

	public getEntropy(password?: string) {
		return lastValueFrom(
			this.sendMessage(
				createMessage<KeyringPayload<'getEntropy'>>({
					type: 'keyring',
					method: 'getEntropy',
					args: password,
					return: undefined,
				}),
			).pipe(
				take(1),
				map(({ payload }) => {
					if (isKeyringPayload(payload, 'getEntropy') && payload.return) {
						return payload.return;
					}
					throw new Error('Mnemonic not found');
				}),
			),
		);
	}

	public setKeyringLockTimeout(timeout: number) {
		return lastValueFrom(
			this.sendMessage(
				createMessage<KeyringPayload<'setLockTimeout'>>({
					type: 'keyring',
					method: 'setLockTimeout',
					args: { timeout },
				}),
			).pipe(take(1)),
		);
	}

	public signData(addressOrID: string, data: Uint8Array): Promise<SerializedSignature> {
		return lastValueFrom(
			this.sendMessage(
				createMessage<MethodPayload<'signData'>>({
					type: 'method-payload',
					method: 'signData',
					args: { data: toB64(data), id: addressOrID },
				}),
			).pipe(
				take(1),
				map(({ payload }) => {
					if (isMethodPayload(payload, 'signDataResponse')) {
						return payload.args.signature;
					}
					throw new Error('Error unknown response for signData message');
				}),
			),
		);
	}

	public setActiveNetworkEnv(network: NetworkEnvType) {
		return lastValueFrom(
			this.sendMessage(
				createMessage<SetNetworkPayload>({
					type: 'set-network',
					network,
				}),
			).pipe(take(1)),
		);
	}

	public selectAccount(accountID: string) {
		return lastValueFrom(
			this.sendMessage(
				createMessage<MethodPayload<'switchAccount'>>({
					type: 'method-payload',
					method: 'switchAccount',
					args: { accountID },
				}),
			).pipe(take(1)),
		);
	}

	public deriveNextAccount() {
		return lastValueFrom(
			this.sendMessage(
				createMessage<KeyringPayload<'deriveNextAccount'>>({
					type: 'keyring',
					method: 'deriveNextAccount',
				}),
			).pipe(
				take(1),
				map(({ payload }) => {
					if (isKeyringPayload(payload, 'deriveNextAccount') && payload.return) {
						return payload.return.accountAddress;
					}
					throw new Error('Error unknown response for derive account message');
				}),
			),
		);
	}

	public verifyPassword(password: string, legacyAccounts: boolean = false) {
		return lastValueFrom(
			this.sendMessage(
				legacyAccounts
					? createMessage<KeyringPayload<'verifyPassword'>>({
							type: 'keyring',
							method: 'verifyPassword',
							args: { password },
					  })
					: createMessage<MethodPayload<'verifyPassword'>>({
							type: 'method-payload',
							method: 'verifyPassword',
							args: { password },
					  }),
			).pipe(take(1)),
		);
	}

	public exportAccount(password: string, accountAddress: string) {
		return lastValueFrom(
			this.sendMessage(
				createMessage<KeyringPayload<'exportAccount'>>({
					type: 'keyring',
					method: 'exportAccount',
					args: { password, accountAddress },
				}),
			).pipe(
				take(1),
				map(({ payload }) => {
					if (isKeyringPayload(payload, 'exportAccount') && payload.return) {
						return payload.return.keyPair;
					}
					throw new Error('Error unknown response for export account message');
				}),
			),
		);
	}

	public importPrivateKey(password: string, keyPair: ExportedKeypair) {
		return lastValueFrom(
			this.sendMessage(
				createMessage<KeyringPayload<'importPrivateKey'>>({
					type: 'keyring',
					method: 'importPrivateKey',
					args: { password, keyPair },
				}),
			).pipe(take(1)),
		);
	}

	public fetchPendingQredoConnectRequest(requestID: string) {
		return lastValueFrom(
			this.sendMessage(
				createMessage<QredoConnectPayload<'getPendingRequest'>>({
					type: 'qredo-connect',
					method: 'getPendingRequest',
					args: { requestID },
				}),
			).pipe(
				take(1),
				map(({ payload }) => {
					if (isQredoConnectPayload(payload, 'getPendingRequestResponse')) {
						return payload.args.request;
					}
					throw new Error('Error unknown response for fetch pending qredo requests message');
				}),
			),
		);
	}

	public getQredoConnectionInfo(qredoID: string, refreshAccessToken = false) {
		return lastValueFrom(
			this.sendMessage(
				createMessage<QredoConnectPayload<'getQredoInfo'>>({
					type: 'qredo-connect',
					method: 'getQredoInfo',
					args: { qredoID, refreshAccessToken },
				}),
			).pipe(
				take(1),
				map(({ payload }) => {
					if (isQredoConnectPayload(payload, 'getQredoInfoResponse')) {
						return payload.args;
					}
					throw new Error('Error unknown response for get qredo info message');
				}),
			),
		);
	}

	public acceptQredoConnection(args: QredoConnectPayload<'acceptQredoConnection'>['args']) {
		return lastValueFrom(
			this.sendMessage(
				createMessage<QredoConnectPayload<'acceptQredoConnection'>>({
					type: 'qredo-connect',
					method: 'acceptQredoConnection',
					args,
				}),
			).pipe(
				take(1),
				map(({ payload }) => {
					if (isQredoConnectPayload(payload, 'acceptQredoConnectionResponse')) {
						return payload.args.accounts;
					}
					throw new Error('Error unknown response for accept qredo connection');
				}),
			),
		);
	}

	public rejectQredoConnection(args: QredoConnectPayload<'rejectQredoConnection'>['args']) {
		return lastValueFrom(
			this.sendMessage(
				createMessage<QredoConnectPayload<'rejectQredoConnection'>>({
					type: 'qredo-connect',
					method: 'rejectQredoConnection',
					args,
				}),
			).pipe(take(1)),
		);
	}

	public getStoredEntities<R>(type: UIAccessibleEntityType): Promise<R[]> {
		return lastValueFrom(
			this.sendMessage(
				createMessage<MethodPayload<'getStoredEntities'>>({
					method: 'getStoredEntities',
					type: 'method-payload',
					args: { type },
				}),
			).pipe(
				take(1),
				map(({ payload }) => {
					if (!isMethodPayload(payload, 'storedEntitiesResponse')) {
						throw new Error('Unknown response');
					}
					if (type !== payload.args.type) {
						throw new Error(`unexpected entity type response ${payload.args.type}`);
					}
					return payload.args.entities;
				}),
			),
		);
	}

	public createMnemonicAccountSource(inputs: { password: string; entropy?: string }) {
		return lastValueFrom(
			this.sendMessage(
				createMessage<MethodPayload<'createAccountSource'>>({
					method: 'createAccountSource',
					type: 'method-payload',
					args: { type: 'mnemonic', params: inputs },
				}),
			).pipe(
				take(1),
				map(({ payload }) => {
					if (!isMethodPayload(payload, 'accountSourceCreationResponse')) {
						throw new Error('Unknown response');
					}
					if ('mnemonic' !== payload.args.accountSource.type) {
						throw new Error(
							`Unexpected account source type response ${payload.args.accountSource.type}`,
						);
					}
					return payload.args.accountSource as unknown as MnemonicSerializedUiAccount;
				}),
			),
		);
	}

	public createAccounts(inputs: MethodPayload<'createAccounts'>['args']) {
		return lastValueFrom(
			this.sendMessage(
				createMessage<MethodPayload<'createAccounts'>>({
					method: 'createAccounts',
					type: 'method-payload',
					args: inputs,
				}),
			).pipe(
				take(1),
				map(({ payload }) => {
					if (!isMethodPayload(payload, 'accountsCreatedResponse')) {
						throw new Error('Unknown response');
					}
					if (inputs.type !== payload.args.accounts[0]?.type) {
						throw new Error(`Unexpected accounts type response ${payload.args.accounts[0]?.type}`);
					}
					return payload.args.accounts;
				}),
			),
		);
	}

	public deleteAccountSourceByType(inputs: MethodPayload<'deleteAccountSourceByType'>['args']) {
		return lastValueFrom(
			this.sendMessage(
				createMessage<MethodPayload<'deleteAccountSourceByType'>>({
					method: 'deleteAccountSourceByType',
					type: 'method-payload',
					args: inputs,
				}),
			).pipe(
				take(1),
				map(({ payload }) => {
					if (!isMethodPayload(payload, 'deleteAccountSourceByTypeResponse')) {
						throw new Error('Unknown response');
					}
					return payload.args.success;
				}),
			),
		);
	}

	public unlockAccountSourceOrAccount(
		inputs: MethodPayload<'unlockAccountSourceOrAccount'>['args'],
	) {
		return lastValueFrom(
			this.sendMessage(
				createMessage<MethodPayload<'unlockAccountSourceOrAccount'>>({
					type: 'method-payload',
					method: 'unlockAccountSourceOrAccount',
					args: inputs,
				}),
			).pipe(take(1)),
		);
	}

	public lockAccountSourceOrAccount({ id }: MethodPayload<'lockAccountSourceOrAccount'>['args']) {
		return lastValueFrom(
			this.sendMessage(
				createMessage<MethodPayload<'lockAccountSourceOrAccount'>>({
					type: 'method-payload',
					method: 'lockAccountSourceOrAccount',
					args: { id },
				}),
			).pipe(take(1)),
		);
	}

	public setAccountNickname({ id, nickname }: MethodPayload<'setAccountNickname'>['args']) {
		return lastValueFrom(
			this.sendMessage(
				createMessage<MethodPayload<'setAccountNickname'>>({
					type: 'method-payload',
					method: 'setAccountNickname',
					args: { id, nickname },
				}),
			).pipe(take(1)),
		);
	}

	public getStorageMigrationStatus() {
		return lastValueFrom(
			this.sendMessage(
				createMessage<MethodPayload<'getStorageMigrationStatus'>>({
					method: 'getStorageMigrationStatus',
					type: 'method-payload',
					args: null,
				}),
			).pipe(
				take(1),
				map(({ payload }) => {
					if (!isMethodPayload(payload, 'storageMigrationStatus')) {
						throw new Error('Unknown response');
					}
					return payload.args.status;
				}),
			),
		);
	}

	public doStorageMigration(inputs: MethodPayload<'doStorageMigration'>['args']) {
		return lastValueFrom(
			this.sendMessage(
				createMessage<MethodPayload<'doStorageMigration'>>({
					type: 'method-payload',
					method: 'doStorageMigration',
					args: inputs,
				}),
			).pipe(take(1)),
		);
	}

	/**
	 * Wallet wasn't storing the public key of ledger accounts, but we need it to send it to the dapps.
	 * Use this function to update the public keys whenever wallet has access to them.
	 */
	public storeLedgerAccountsPublicKeys(
		args: MethodPayload<'storeLedgerAccountsPublicKeys'>['args'],
	) {
		return lastValueFrom(
			this.sendMessage(
				createMessage<MethodPayload<'storeLedgerAccountsPublicKeys'>>({
					type: 'method-payload',
					method: 'storeLedgerAccountsPublicKeys',
					args,
				}),
			).pipe(take(1)),
		);
	}

	public getAccountSourceEntropy(accountSourceID: string) {
		return lastValueFrom(
			this.sendMessage(
				createMessage<MethodPayload<'getAccountSourceEntropy'>>({
					type: 'method-payload',
					method: 'getAccountSourceEntropy',
					args: { accountSourceID },
				}),
			).pipe(
				take(1),
				map(({ payload }) => {
					if (isMethodPayload(payload, 'getAccountSourceEntropyResponse')) {
						return payload.args;
					}
					throw new Error('Unexpected response type');
				}),
			),
		);
	}

	private setupAppStatusUpdateInterval() {
		setInterval(() => {
			this.sendAppStatus();
		}, APP_STATUS_UPDATE_INTERVAL);
	}

	private sendAppStatus() {
		const active = document.visibilityState === 'visible';
		this.sendMessage(
			createMessage<KeyringPayload<'appStatusUpdate'>>({
				type: 'keyring',
				method: 'appStatusUpdate',
				args: { active },
			}),
		);
	}

	private loadFeatures() {
		return lastValueFrom(
			this.sendMessage(
				createMessage<BasePayload>({
					type: 'get-features',
				}),
			).pipe(take(1)),
		);
	}

	private getNetwork() {
		return lastValueFrom(
			this.sendMessage(
				createMessage<BasePayload>({
					type: 'get-network',
				}),
			).pipe(take(1)),
		);
	}

	private handleIncomingMessage(msg: Message) {
		if (!this._initialized || !this._dispatch) {
			throw new Error('BackgroundClient is not initialized to handle incoming messages');
		}
		const { payload } = msg;
		let action;
		if (isPermissionRequests(payload)) {
			action = setPermissions(payload.permissions);
		} else if (isGetTransactionRequestsResponse(payload)) {
			action = setTransactionRequests(payload.txRequests);
		} else if (isUpdateActiveOrigin(payload)) {
			action = setActiveOrigin(payload);
		} else if (isLoadedFeaturesPayload(payload)) {
			growthbook.setAttributes(payload.attributes);
			growthbook.setFeatures(payload.features);
		} else if (isSetNetworkPayload(payload)) {
			action = changeActiveNetwork({
				network: payload.network,
			});
		} else if (isMethodPayload(payload, 'entitiesUpdated')) {
			const entitiesQueryKey = entitiesToClientQueryKeys[payload.args.type];
			if (entitiesQueryKey) {
				queryClient.invalidateQueries(entitiesQueryKey);
			}
		}
		if (action) {
			this._dispatch(action);
		}
	}

	private createPortStream() {
		this._portStream = PortStream.connectToBackgroundService('sui_ui<->background');
		this._portStream.onDisconnect.subscribe(() => {
			this.createPortStream();
		});
		this._portStream.onMessage.subscribe((msg) => this.handleIncomingMessage(msg));
	}

	private sendMessage(msg: Message) {
		if (this._portStream?.connected) {
			return this._portStream.sendMessage(msg);
		} else {
			throw new Error('Failed to send message to background service. Port not connected.');
		}
	}
}
