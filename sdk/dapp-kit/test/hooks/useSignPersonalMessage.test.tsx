// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { renderHook, waitFor, act } from '@testing-library/react';
import { useConnectWallet, useSignPersonalMessage, useWallet } from 'dapp-kit/src';
import { createWalletProviderContextWrapper, registerMockWallet } from '../test-utils.js';
import {
	WalletFeatureNotSupportedError,
	WalletNotConnectedError,
} from 'dapp-kit/src/errors/walletErrors.js';
import type { Mock } from 'vitest';

describe('useSignPersonalMessage', () => {
	test('should throw an error when trying to sign a message without a wallet connection', async () => {
		const wrapper = createWalletProviderContextWrapper();
		const { result } = renderHook(() => useSignPersonalMessage(), { wrapper });

		result.current.mutate({ message: new Uint8Array() });

		await waitFor(() => expect(result.current.error).toBeInstanceOf(WalletNotConnectedError));
	});

	test('should throw an error when trying to sign a message with a wallet that lacks feature support', async () => {
		const wrapper = createWalletProviderContextWrapper();
		const { result } = renderHook(() => useSignPersonalMessage(), { wrapper });

		result.current.mutate({ message: new Uint8Array() });

		await waitFor(() =>
			expect(result.current.error).toBeInstanceOf(WalletFeatureNotSupportedError),
		);
	});

	test('signing a personal message from the currently connected account works successfully', async () => {
		const { unregister, mockWallet } = registerMockWallet('Mock Wallet 1');

		const wrapper = createWalletProviderContextWrapper();
		const { result } = renderHook(
			() => ({
				connectWallet: useConnectWallet(),
				signPersonalMessage: useSignPersonalMessage(),
				walletInfo: useWallet(),
			}),
			{ wrapper },
		);

		result.current.connectWallet.mutate({ wallet: mockWallet });

		await waitFor(() => expect(result.current.connectWallet.isSuccess).toBe(true));
		expect(result.current.walletInfo.connectionStatus).toBe('connected');

		const signPersonalMessageFeature =
			result.current.walletInfo.currentWallet!.features['sui:signPersonalMessage'];
		const signPersonalMessageMock = signPersonalMessageFeature.signPersonalMessage as Mock;

		signPersonalMessageMock.mockReturnValue({ bytes: 'abc', signature: '123' });

		result.current.signPersonalMessage.mutate({
			message: new Uint8Array().fill(123),
		});

		await waitFor(() => expect(result.current.signPersonalMessage.isSuccess).toBe(true));
		expect(result.current.signPersonalMessage.data).toStrictEqual({
			bytes: 'abc',
			signature: '123',
		});

		act(() => {
			unregister();
		});
	});
});