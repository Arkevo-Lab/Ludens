"""Workspace-owned perception. Implement this class, then run ludens perception reload."""

from ludens_tools import capability, observe, record


class Perception:
    def start(self, context):
        """Initialize models/state once; discover device abilities in baseware.json."""
        self.context = context

    @observe
    @record
    @capability
    def sample(self):
        """Return an observation: optional text, JSON data, media, space and sources.

        media: [{"path": "frame.png", "mediaType": "image/png"}], or base64 data
        instead of path. sampledAt optionally supplies a known source timestamp.
        Capabilities in the continuous state machine may also return optional
        effect and transition fields in their dict for closed-loop control.
        The instance stays alive; choose continuous or on-demand work as useful.
        @record adds this result to the workspace timeline and returns a timeline
        reference. observe() reads that history, across runs, without resampling.
        Plain @capability functions do not record; add @record only where useful.
        """
        raise NotImplementedError("Implement workspace perception, then reload it.")

    def close(self):
        """Stop your background workers and release local resources."""
        pass
