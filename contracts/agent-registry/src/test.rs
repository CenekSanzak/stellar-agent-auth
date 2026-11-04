extern crate std;
use soroban_sdk::{testutils::{Address as _, MockAuth, MockAuthInvoke}, xdr::{AccountId, PublicKey, ScAddress, Uint256}, Address, BytesN, Env, IntoVal, String, TryFromVal};
use crate::{AgentRegistry, AgentRegistryClient};

fn account(env: &Env, seed: u8) -> Address {
    Address::try_from_val(env, &ScAddress::Account(AccountId(PublicKey::PublicKeyTypeEd25519(Uint256([seed; 32]))))).unwrap()
}

#[test]
fn probe() {
    let env = Env::default();
    let id = env.register(AgentRegistry, ());
    let client = AgentRegistryClient::new(&env, &id);
    let controller = account(&env, 1);
    let signer = account(&env, 2);
    let uri = String::from_str(&env, "https://a");
    let hash = BytesN::from_array(&env, &[1; 32]);
    let args = (controller.clone(), signer.clone(), uri.clone(), hash.clone()).into_val(&env);
    let invoke = MockAuthInvoke { contract: &id, fn_name: "register", args, sub_invokes: &[] };
    env.mock_auths(&[MockAuth { address: &controller, invoke: &invoke }]);
    std::println!("missing signer: {:?}", client.try_register(&controller, &signer, &uri, &hash));
    env.mock_auths(&[MockAuth { address: &controller, invoke: &invoke }, MockAuth { address: &signer, invoke: &invoke }]);
    std::println!("both: {:?}", client.try_register(&controller, &signer, &uri, &hash));
    let c = Address::generate(&env);
    std::println!("contract signer: {:?}", { env.mock_all_auths(); client.try_register(&controller, &c, &uri, &hash) });
}
