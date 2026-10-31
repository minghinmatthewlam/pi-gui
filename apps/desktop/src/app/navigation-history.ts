import type { AppView } from "../../contracts/desktop-state";
import type { SettingsSection } from "../features/settings/settings-view";

export interface AppLocation {
  readonly view: AppView;
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly section?: SettingsSection;
}

export class NavigationHistory {
  private entries: AppLocation[] = [];
  private index = -1;

  record(location: AppLocation) {
    if (JSON.stringify(this.entries[this.index]) === JSON.stringify(location)) return;
    this.entries = [...this.entries.slice(0, this.index + 1), location].slice(-200);
    this.index = this.entries.length - 1;
  }

  move(direction: -1 | 1, isAvailable: (location: AppLocation) => boolean) {
    for (
      let index = this.index + direction;
      index >= 0 && index < this.entries.length;
      index += direction
    ) {
      const location = this.entries[index];
      if (location && isAvailable(location)) {
        this.index = index;
        return location;
      }
    }
    return undefined;
  }
}
