import type { ExtensionCompatibilityIssue } from "@pi-gui/session-driver";

const UNSUPPORTED_HOST_UI_PREFIX = "__PI_GUI_UNSUPPORTED_HOST_UI__:";

export function createUnsupportedHostUiIssue(capability: string): ExtensionCompatibilityIssue {
  return {
    capability,
    classification: "terminal-only",
    message: genericUnsupportedCapabilityMessage(capability),
  };
}

export function createUnsupportedHostUiError(capability: string): Error {
  return new Error(serializeUnsupportedHostUiIssue(createUnsupportedHostUiIssue(capability)));
}

export function parseUnsupportedHostUiErrorMessage(
  message: string,
): ExtensionCompatibilityIssue | undefined {
  if (!message.startsWith(UNSUPPORTED_HOST_UI_PREFIX)) {
    return undefined;
  }

  try {
    return JSON.parse(
      message.slice(UNSUPPORTED_HOST_UI_PREFIX.length),
    ) as ExtensionCompatibilityIssue;
  } catch {
    return undefined;
  }
}

export function serializeUnsupportedHostUiIssue(issue: ExtensionCompatibilityIssue): string {
  return `${UNSUPPORTED_HOST_UI_PREFIX}${JSON.stringify(issue)}`;
}

export function genericUnsupportedCapabilityMessage(capability: string): string {
  return `Terminal-only ${labelForCapability(capability)} is not supported in pi-gui. Use pi in the terminal for that workflow.`;
}

export function commandUnsupportedCapabilityMessage(
  commandName: string,
  capability: string,
): string {
  return `/${commandName} requires terminal-only ${labelForCapability(capability)} and is not supported in pi-gui yet. Use pi in the terminal for this command.`;
}

function labelForCapability(capability: string): string {
  switch (capability) {
    case "custom":
      return "custom UI";
    case "onTerminalInput":
      return "terminal input";
    case "setEditorComponent":
      return "custom editor UI";
    case "setFooter":
      return "footer UI";
    case "setHeader":
      return "header UI";
    default:
      return capability.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  }
}
