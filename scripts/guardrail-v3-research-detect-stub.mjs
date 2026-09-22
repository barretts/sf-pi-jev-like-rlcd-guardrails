/** Local-only org discovery for the v3 TRAIN/VALID research replay. */
export function detectProject(cwd) {
  return { detected: false, projectRoot: cwd };
}

export async function detectConfig() {
  return { hasTargetOrg: false };
}

export async function detectOrg() {
  return { detected: false, orgType: "unknown" };
}

export async function detectEnvironment() {
  return {
    cli: { installed: false },
    project: { detected: false },
    config: { hasTargetOrg: false },
    org: { detected: false, orgType: "unknown" },
    detectedAt: 0,
  };
}
