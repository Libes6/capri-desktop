//! The folder picker (TAURI-07): platform.dialogs.pickFolder(defaultPath) -> path | null, through
//! tauri-plugin-dialog (NSOpenPanel, the Windows folder dialog, GTK / the desktop portal). The plugin is
//! used from Rust only: no capability grants her pages any dialog command.

use std::path::{Path, PathBuf};

/// Whatever shows a folder picker: the plugin, or a fake in the tests.
pub trait Picker {
    fn pick_folder(&self, start: Option<&Path>) -> Option<PathBuf>;
}

pub struct SystemPicker(pub tauri::AppHandle);

impl Picker for SystemPicker {
    /// Blocks until the user answers: never on the main thread.
    fn pick_folder(&self, start: Option<&Path>) -> Option<PathBuf> {
        use tauri_plugin_dialog::DialogExt;
        let mut dialog = self.0.dialog().file();
        if let Some(dir) = start {
            dialog = dialog.set_directory(dir);
        }
        dialog.blocking_pick_folder().and_then(|p| p.into_path().ok())
    }
}

/// Where the picker opens: the folder asked for, if it is an absolute one that exists.
pub fn start_dir(default: Option<&str>) -> Option<PathBuf> {
    let p = Path::new(default?);
    (p.is_absolute() && p.is_dir()).then(|| p.to_path_buf())
}

/// pickFolder's answer: the chosen path, or null when the user cancelled (or it is not text).
pub fn pick_folder(picker: &dyn Picker, default: Option<&str>) -> Option<String> {
    picker.pick_folder(start_dir(default).as_deref()).and_then(|p| p.to_str().map(str::to_string))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    struct Fake {
        answer: Option<PathBuf>,
        asked: RefCell<Vec<Option<PathBuf>>>,
    }

    impl Picker for Fake {
        fn pick_folder(&self, start: Option<&Path>) -> Option<PathBuf> {
            self.asked.borrow_mut().push(start.map(Path::to_path_buf));
            self.answer.clone()
        }
    }

    #[test]
    fn the_chosen_folder_comes_back_and_a_cancel_is_null() {
        let f = Fake { answer: Some("/Users/x/project".into()), asked: Default::default() };
        assert_eq!(pick_folder(&f, None).as_deref(), Some("/Users/x/project"));
        let c = Fake { answer: None, asked: Default::default() };
        assert_eq!(pick_folder(&c, None), None);
    }

    #[test]
    fn it_opens_in_the_folder_asked_for_only_when_that_is_a_real_one() {
        let tmp = std::env::temp_dir();
        let f = Fake { answer: None, asked: Default::default() };
        pick_folder(&f, tmp.to_str());
        pick_folder(&f, Some("/no/such/folder-7f3a"));
        pick_folder(&f, Some("relative"));
        pick_folder(&f, Some(""));
        assert_eq!(*f.asked.borrow(), vec![Some(tmp), None, None, None]);
    }
}
