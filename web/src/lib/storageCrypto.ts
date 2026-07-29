// Client-side credential encryption for BYO-S3 storage (phase 18b).
//
// Trust story: S3 credentials are NIP-44 v2 encrypted to the Evenflow
// SERVER's static pubkey — never to the org audience, so org members can't
// read them. Login identities carry no secp256k1 key (OAuth stand-ins until
// KMS), so we encrypt with an EPHEMERAL sender keypair, ECIES-style: the
// ciphertext travels with the ephemeral pubkey, and the server ECDHs its
// privkey against it. The ephemeral privkey and conversation key are zeroed
// before this function returns; callers must clear their own plaintext
// state after the PUT.

import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { encrypt, getConversationKey } from "nostr-tools/nip44";

export interface EncryptedCreds {
  readonly ciphertext: string;
  readonly senderPubkey: string;
}

export const encryptCredsToServer = (
  serverPubkeyHex: string,
  creds: { access_key_id: string; secret_access_key: string },
): EncryptedCreds => {
  const ephemeral = generateSecretKey();
  try {
    const conversationKey = getConversationKey(ephemeral, serverPubkeyHex);
    const ciphertext = encrypt(JSON.stringify(creds), conversationKey);
    conversationKey.fill(0);
    return { ciphertext, senderPubkey: getPublicKey(ephemeral) };
  } finally {
    ephemeral.fill(0);
  }
};
