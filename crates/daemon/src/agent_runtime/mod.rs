//! Async orchestration for agent sessions: command handlers, reader threads,
//! journal fan-out. The data structures live in `kanna_daemon::agent`.

mod commands;
mod common;
mod lifecycle;
mod reader;

pub use commands::{
    handle_agent_input, handle_agent_interrupt, handle_agent_permission, handle_agent_set_model,
    handle_attach_agent, handle_spawn_agent,
};
pub use lifecycle::{
    adopt_agent_session, agent_session_infos, cleanup_agent_writer, detach_agent_writer,
    kill_agent_session,
};
