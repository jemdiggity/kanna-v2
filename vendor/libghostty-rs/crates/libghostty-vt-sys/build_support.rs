use std::fs;
use std::io;
use std::path::{Path, PathBuf};

const UNUSED_DYNAMIC_LIBRARY_ALIASES: [&str; 2] = ["libghostty-vt.0.dylib", "libghostty-vt.dylib"];

pub fn remove_unused_dynamic_library_symlinks(root: &Path) -> io::Result<Vec<PathBuf>> {
    let mut removed = Vec::new();
    remove_aliases_below(root, &mut removed)?;
    removed.sort();
    Ok(removed)
}

fn remove_aliases_below(directory: &Path, removed: &mut Vec<PathBuf>) -> io::Result<()> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            remove_aliases_below(&path, removed)?;
            continue;
        }

        if file_type.is_symlink()
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| UNUSED_DYNAMIC_LIBRARY_ALIASES.contains(&name))
        {
            fs::remove_file(&path)?;
            removed.push(path);
        }
    }
    Ok(())
}
