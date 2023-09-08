// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useNavigate } from 'react-router-dom';
import { ImportRecoveryPhraseForm } from '../../components/accounts/ImportRecoveryPhraseForm';
import { Heading } from '../../shared/heading';
import { Text } from '../../shared/text';
import { useAccountsFormContext } from '../../components/accounts/AccountsFormContext';
import { entropyToSerialized, mnemonicToEntropy } from '_src/shared/utils/bip39';

export function ForgotPasswordPage() {
	const navigate = useNavigate();
	const [, setFormValues] = useAccountsFormContext();
	return (
		<div className="rounded-20 bg-sui-lightest shadow-wallet-content flex flex-col items-center px-6 py-10 h-full overflow-auto gap-6">
			<div className="flex flex-col items-center gap-2">
				<Heading variant="heading1" color="gray-90" as="h1" weight="bold">
					Forgot Password?
				</Heading>
				<Text variant="pBody" color="gray-90">
					Enter your 12-word Recovery Phrase
				</Text>
			</div>
			<div className="grow">
				<ImportRecoveryPhraseForm
					cancelButtonText="Cancel"
					submitButtonText="Next"
					onSubmit={({ recoveryPhrase }) => {
						setFormValues({
							type: 'import-mnemonic',
							entropy: entropyToSerialized(mnemonicToEntropy(recoveryPhrase.join(' '))),
						});
						navigate('/reset-password/warning/');
					}}
				/>
			</div>
		</div>
	);
}
