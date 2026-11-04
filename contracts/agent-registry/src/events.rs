use soroban_sdk::Env;
use stellar_agent_auth_shared_types::{events::IdentityChanged, identity::AgentIdentity};

/// Publishes `identity_v1` with the identity after the change.
pub fn identity_changed(env: &Env, identity: &AgentIdentity) {
    IdentityChanged {
        agent_id: identity.agent_id,
        identity: identity.clone(),
    }
    .publish(env);
}
