/** Native Web Crypto key type in either DOM or Node environments; no key bytes or custom primitive. */
export type EndpointCryptoKey = InstanceType<typeof globalThis.CryptoKey>;
export interface EndpointCryptoKeyPair { publicKey: EndpointCryptoKey; privateKey: EndpointCryptoKey }
