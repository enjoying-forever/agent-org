"""Entry point that harnesses run for agent-org hooks: python org_hook.py <event>.

It works from any folder, because it puts this directory on the import path first.
See agent_org/hooks.py for the events.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from agent_org.hooks import main  # noqa: E402

sys.exit(main())
