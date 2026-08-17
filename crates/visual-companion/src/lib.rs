mod discovery;
mod event;

pub use discovery::{
    current_bundle, CompanionBundle, CompanionError, CompanionMaterializationBudget,
    CompanionMaterializationPermit, CompanionScan, CompanionScanner,
    MAX_COMPANION_ASSETLESS_MATERIALIZED_BYTES, MAX_COMPANION_ASSET_BYTES,
    MAX_COMPANION_ASSET_COUNT, MAX_COMPANION_ASSET_TOTAL_BYTES, MAX_COMPANION_DIRECTORY_ENTRIES,
    MAX_COMPANION_DIRECTORY_NAME_BYTES, MAX_COMPANION_HTML_BYTES,
    MAX_COMPANION_INLINE_IMAGE_TOTAL_BYTES, MAX_COMPANION_MATERIALIZED_BYTES,
    MAX_COMPANION_PREPARED_HTML_BYTES,
};
pub use event::append_event;
#[doc(hidden)]
pub use event::append_event_with_workspace_resolver;

#[cfg(test)]
mod tests;
