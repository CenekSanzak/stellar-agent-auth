#![no_std]
//! P0 host/ABI probe only. Payment service behavior is implemented in P9.
use soroban_sdk::{contract, contractimpl, BytesN, Env};
pub mod service;
#[contract]
pub struct DemoService;
#[contractimpl]
impl DemoService {
    /// Non-economic probe used to verify contract build and host dispatch.
    pub fn probe(_env: Env, nonce: BytesN<32>) -> BytesN<32> {
        nonce
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn host_dispatch_preserves_typed_payload() {
        let env = Env::default();
        let id = env.register(DemoService, ());
        let client = DemoServiceClient::new(&env, &id);
        let nonce = BytesN::from_array(&env, &[42; 32]);
        assert_eq!(client.probe(&nonce), nonce);
    }
}
