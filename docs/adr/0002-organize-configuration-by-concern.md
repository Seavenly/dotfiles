# Organize configuration by concern

Tracked configuration lives under `config/`, organized by the application or
concern that owns it rather than by mirroring `$HOME`. Mise records destination
paths explicitly, which keeps the repository navigable while allowing
platform-appropriate destinations to vary.
