# C9 Q8 manifest handoff

The FIT exporter produces F16 weights. The frozen Q8_0 conversion runs in the
FIT owner's isolated worktree, where the generated manifest and GGUF initially
live under ignored `.build/guardrail/` paths. For each arm, copy the generated
manifest **byte for byte** into `A-q8.json` or `B-q8.json` here, record its
SHA-256, and commit that copy before any TRAIN-CAL model call. Do not copy or
commit the GGUF into this directory.

The CAL scorer accepts only these two tracked paths. It checks the supplied
manifest SHA against the file and `git show HEAD:<path>`; the file must be
committed and unchanged. The manifest binds the admitted F16 export and its
registry, the Q8 output and registry, quantizer revision and executable hash,
all eight adjacent library payload hashes, and every adjacent `.dylib` symlink
target. The scorer rechecks those files and links after scoring. The selected
arm's exact committed manifest SHA belongs in the CAL score and selector
receipt. A regenerated or edited manifest needs a new pre-CAL freeze.

The F16 weights remain the parent artifact. This handoff alone does not
establish Q8 decision fidelity, TRAIN-CAL selection, prospective VALID
effectiveness, or held-out qualification.
