use soroban_sdk::{BytesN, Env, String};
use stellar_agent_auth_shared_types::{
    errors::Error,
    identity::{validate_metadata, MAX_METADATA_URI_BYTES},
};

fn uri_of_len(env: &Env, len: u32) -> String {
    let mut bytes = b"https://".to_vec();
    bytes.resize(len as usize, b'a');
    String::from_bytes(env, &bytes)
}

#[test]
fn metadata_validation_matches_the_v1_rules() {
    let env = Env::default();
    let hash = BytesN::from_array(&env, &[7; 32]);
    let zero = BytesN::from_array(&env, &[0; 32]);
    let check =
        |uri: &[u8], hash: &BytesN<32>| validate_metadata(&String::from_bytes(&env, uri), hash);

    assert_eq!(check(b"https://a", &hash), Ok(()));
    assert_eq!(check(b"https://!", &hash), Ok(()));
    assert_eq!(
        check(b"https://example.com/agent.json?v=1#~", &hash),
        Ok(())
    );
    assert_eq!(
        validate_metadata(&uri_of_len(&env, MAX_METADATA_URI_BYTES), &hash),
        Ok(())
    );
    assert_eq!(
        validate_metadata(&uri_of_len(&env, MAX_METADATA_URI_BYTES + 1), &hash),
        Err(Error::LimitExceeded)
    );
    for uri in [
        &b""[..],
        b"https://",
        b"http://example.com",
        b"HTTPS://example.com",
        b"ipfs://cid",
        b" https://example.com",
        b"https://exa mple.com",
        b"https://example.com\n",
        b"https://example.com\x7f",
        b"https://example.com\x00",
        "https://exämple.com".as_bytes(),
    ] {
        assert_eq!(check(uri, &hash), Err(Error::InvalidInput), "{uri:?}");
    }
    assert_eq!(check(b"https://a", &zero), Err(Error::InvalidInput));
    let mut almost_zero = [0; 32];
    almost_zero[31] = 1;
    assert_eq!(
        check(b"https://a", &BytesN::from_array(&env, &almost_zero)),
        Ok(())
    );
}
