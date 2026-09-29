"""Entry point that harnesses run for agent-org hooks: python org_hook.py <event>.

It works from any folder, because it puts this directory on the import path first.
See agent_org/hooks.py for the events.
"""

import os
import sys

if not (os.environ.get("AGENT_ORG_TEAM") and os.environ.get("AGENT_ORG_ROLE")):
    # Not an agent-org tab (Grok's hooks are global): do nothing, and quickly.
    if "agy" in sys.argv[2:]:  # Antigravity expects an answer from every hook; a pre-tool one needs a decision
        sys.stdout.write('{"decision": "ask"}' if sys.argv[1:2] == ["pre-edit"] else "{}")
    sys.exit(0)

from pathlib import Path  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))

from agent_org.hooks import main  # noqa: E402

sys.exit(main())
