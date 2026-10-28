//! The system key store (TAURI-07): the macOS Keychain, the Windows Credential Manager, the Secret
//! Service (GNOME Keyring, KWallet) on Linux, through the `keyring` crate.
//!
//! What lives there is ONE item: a random 256-bit master key. The core (Node) asks for it once, at
//! start (`secrets.masterKey`), and seals the API keys in config.json with it, synchronously, as
//! `kc:<base64 of nonce | ciphertext | tag>` (AES-256-GCM, src/main/platform/sidecar.js). The core's
//! interface is synchronous (setup.js createKeys), which a per-key round trip to Rust could not be.
//! The API keys themselves never reach her pages or any log, and neither does the master key.
//!
//! No store (Linux without a Secret Service, a locked or denied keychain): `available: false`, and the
//! core behaves as Electron does without safeStorage: keys stay plain text in config.json.
//!
//! CAPRI_KEYCHAIN_SERVICE names another service (tests, a try-out), so a real item is never touched.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};

pub const SERVICE: &str = "capri.desktop";
pub const ACCOUNT: &str = "master-key";
const KEY_BYTES: usize = 32;

/// Where secrets are kept: the system's, or a fake in the tests.
pub trait Backend: Send + Sync {
    fn get(&self, service: &str, account: &str) -> Result<Option<String>, String>;
    fn set(&self, service: &str, account: &str, value: &str) -> Result<(), String>;
    #[cfg_attr(not(test), allow(dead_code))]
    fn delete(&self, service: &str, account: &str) -> Result<(), String>;
}

pub struct SystemBackend;

impl SystemBackend {
    fn entry(service: &str, account: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(service, account).map_err(|e| e.to_string())
    }
}

impl Backend for SystemBackend {
    fn get(&self, service: &str, account: &str) -> Result<Option<String>, String> {
        match Self::entry(service, account)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }
    fn set(&self, service: &str, account: &str, value: &str) -> Result<(), String> {
        Self::entry(service, account)?.set_password(value).map_err(|e| e.to_string())
    }
    fn delete(&self, service: &str, account: &str) -> Result<(), String> {
        match Self::entry(service, account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

pub fn service_name() -> String {
    std::env::var("CAPRI_KEYCHAIN_SERVICE").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| SERVICE.to_string())
}

fn decode_key(text: &str) -> Option<[u8; KEY_BYTES]> {
    STANDARD.decode(text.trim()).ok()?.try_into().ok()
}

fn fresh_key() -> Result<String, String> {
    let mut bytes = [0u8; KEY_BYTES];
    getrandom::fill(&mut bytes).map_err(|e| format!("no randomness: {e}"))?;
    Ok(STANDARD.encode(bytes))
}

/// The master key (base64) from the store, made and kept there on first use. Err: the store does not
/// work. A stored value that is not a key is not overwritten (it may be someone's, or a reader that
/// failed for a moment): that is an error too, so the core does not seal with a key it cannot get back.
pub fn master_key(backend: &dyn Backend, service: &str) -> Result<String, String> {
    if let Some(stored) = backend.get(service, ACCOUNT)? {
        return decode_key(&stored).map(|_| stored.trim().to_string()).ok_or_else(|| "the stored master key is not a 256-bit key".to_string());
    }
    let key = fresh_key()?;
    backend.set(service, ACCOUNT, &key)?;
    // read back: some stores accept a write they then do not keep (a locked keychain, a session bus with no keyring)
    match backend.get(service, ACCOUNT)? {
        Some(v) if v.trim() == key => Ok(key),
        _ => Err("the key store did not keep the master key".to_string()),
    }
}

/// The answer to `secrets.masterKey`: the key, or why there is none.
pub fn master_key_answer(backend: &dyn Backend, service: &str) -> Value {
    match master_key(backend, service) {
        Ok(key) => json!({ "available": true, "key": key }),
        Err(reason) => json!({ "available": false, "reason": reason }),
    }
}

/// Removes the master key (tests, cleaning up a try-out). The API keys sealed with it become unreadable.
#[cfg_attr(not(test), allow(dead_code))]
pub fn forget(backend: &dyn Backend, service: &str) -> Result<(), String> {
    backend.delete(service, ACCOUNT)
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Default)]
    pub struct Memory {
        pub map: Mutex<HashMap<(String, String), String>>,
        pub forgetful: bool,
        pub broken: bool,
    }

    impl Backend for Memory {
        fn get(&self, s: &str, a: &str) -> Result<Option<String>, String> {
            if self.broken {
                return Err("no secret service".into());
            }
            Ok(self.map.lock().unwrap().get(&(s.into(), a.into())).cloned())
        }
        fn set(&self, s: &str, a: &str, v: &str) -> Result<(), String> {
            if self.broken {
                return Err("no secret service".into());
            }
            if !self.forgetful {
                self.map.lock().unwrap().insert((s.into(), a.into()), v.into());
            }
            Ok(())
        }
        fn delete(&self, s: &str, a: &str) -> Result<(), String> {
            self.map.lock().unwrap().remove(&(s.into(), a.into()));
            Ok(())
        }
    }

    #[test]
    fn makes_a_key_once_and_gives_the_same_one_after() {
        let store = Memory::default();
        let a = master_key(&store, "svc").unwrap();
        assert_eq!(decode_key(&a).unwrap().len(), 32);
        assert_eq!(master_key(&store, "svc").unwrap(), a);
        assert_ne!(master_key(&store, "other").unwrap(), a, "services are separate");
    }

    #[test]
    fn keys_are_random() {
        assert_ne!(fresh_key().unwrap(), fresh_key().unwrap());
    }

    #[test]
    fn no_store_is_not_available_and_says_why() {
        let store = Memory { broken: true, ..Default::default() };
        let v = master_key_answer(&store, "svc");
        assert_eq!(v["available"], json!(false));
        assert!(v["reason"].as_str().unwrap().contains("no secret service"));
        assert!(v.get("key").is_none());
    }

    #[test]
    fn a_store_that_does_not_keep_what_it_is_given_is_not_available() {
        let store = Memory { forgetful: true, ..Default::default() };
        assert_eq!(master_key_answer(&store, "svc")["available"], json!(false));
    }

    #[test]
    fn something_else_in_the_slot_is_left_alone() {
        let store = Memory::default();
        store.set("svc", ACCOUNT, "not a key").unwrap();
        assert!(master_key(&store, "svc").is_err());
        assert_eq!(store.get("svc", ACCOUNT).unwrap().as_deref(), Some("not a key"));
    }

    #[test]
    fn forget_removes_it_and_a_new_one_is_made() {
        let store = Memory::default();
        let a = master_key(&store, "svc").unwrap();
        forget(&store, "svc").unwrap();
        assert!(store.get("svc", ACCOUNT).unwrap().is_none());
        assert_ne!(master_key(&store, "svc").unwrap(), a);
    }

    #[test]
    fn the_answer_carries_the_key_only_when_there_is_one() {
        let v = master_key_answer(&Memory::default(), "svc");
        assert_eq!(v["available"], json!(true));
        assert!(decode_key(v["key"].as_str().unwrap()).is_some());
    }

    /// Live, on this machine's real store: a master key under a throwaway service, read back, removed.
    /// Opt in (it can ask for a keychain password on some setups): CAPRI_LIVE_KEYCHAIN=1.
    #[test]
    fn live_system_store_round_trip() {
        if std::env::var_os("CAPRI_LIVE_KEYCHAIN").is_none() {
            eprintln!("skipped: set CAPRI_LIVE_KEYCHAIN=1 to try the real key store");
            return;
        }
        let mut rnd = [0u8; 6];
        getrandom::fill(&mut rnd).unwrap();
        let service = format!("capri.desktop.test.{}", rnd.iter().map(|b| format!("{b:02x}")).collect::<String>());
        let store = SystemBackend;
        let result = std::panic::catch_unwind(|| {
            let a = master_key(&SystemBackend, &service).unwrap();
            assert_eq!(master_key(&SystemBackend, &service).unwrap(), a);
        });
        forget(&store, &service).unwrap();
        assert!(store.get(&service, ACCOUNT).unwrap().is_none(), "cleaned up");
        result.unwrap();
    }
}
