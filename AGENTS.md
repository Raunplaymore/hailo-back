## Project Workspace

This folder is part of one multi-repository Raspberry Pi/Hailo project.
When working here, treat these sibling folders as the same project workspace and inspect them when behavior crosses project boundaries:

- `pi_web`: `/Users/hwangjunguk/Desktop/dir_UK/dir_sandbox/pi_web`
- `pi_service`: `/Users/hwangjunguk/Desktop/dir_UK/dir_sandbox/pi_service`
- `pi_camera`: `/Users/hwangjunguk/Desktop/dir_UK/dir_sandbox/pi_camera`
- `hailo-infer`: `/Users/hwangjunguk/Desktop/dir_UK/dir_sandbox/hailo-infer`

Before changing API contracts, camera/inference flows, shared configuration, deployment scripts, or integration behavior, check the relevant sibling project paths above instead of reasoning from this folder alone.

<!-- CODEX-AGENT-CREWS-START -->
## Codex Agent Crews

If `.codex/crews-routing.md` exists, read it before making code changes in this project.
Also read `.codex/crews-config.md` and `.codex/stack-profile.md` when they exist.

These files define project stack rules, custom constraints, workflow routing, and validation expectations.
<!-- CODEX-AGENT-CREWS-END -->
