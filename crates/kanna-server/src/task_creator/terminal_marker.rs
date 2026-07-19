fn sanitize_stage_name(stage: &str) -> String {
    stage
        .chars()
        .filter(|character| !character.is_control())
        .collect()
}

pub(super) fn format_stage_transition_marker(from: &str, to: &str) -> Vec<u8> {
    format!(
        "\r\n\x1b[2m━━ Stage advanced: {} → {} ━━\x1b[0m\r\n",
        sanitize_stage_name(from),
        sanitize_stage_name(to),
    )
    .into_bytes()
}

#[cfg(test)]
mod tests {
    use super::format_stage_transition_marker;

    #[test]
    fn formats_dim_stage_transition_separator() {
        assert_eq!(
            format_stage_transition_marker("in progress", "review"),
            "\r\n\x1b[2m━━ Stage advanced: in progress → review ━━\x1b[0m\r\n"
                .as_bytes()
                .to_vec()
        );
    }

    #[test]
    fn strips_terminal_control_characters_from_stage_names() {
        assert_eq!(
            format_stage_transition_marker("in\nprogress\x1b[31m", "re\rview"),
            "\r\n\x1b[2m━━ Stage advanced: inprogress[31m → review ━━\x1b[0m\r\n"
                .as_bytes()
                .to_vec()
        );
    }
}
