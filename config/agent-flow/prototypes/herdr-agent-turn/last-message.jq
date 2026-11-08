def joined_text($content_type):
  if type == "string" then
    .
  else
    [ .[] | select(.type == $content_type) | .text ] | join("")
  end;

if $agent == "codex" then
  ([ .[]
    | select(
        .type == "response_item"
        and .payload.type == "message"
        and .payload.role == "assistant"
        and (.payload.phase // "final_answer") == "final_answer"
      )
  ] | last | .payload.content | joined_text("output_text"))
elif $agent == "claude" then
  ([ .[]
    | select(
        .type == "assistant"
        and .message.role == "assistant"
        and .message.stop_reason == "end_turn"
      )
  ] | last | .message.content | joined_text("text"))
else
  error("unsupported agent: " + $agent)
end

