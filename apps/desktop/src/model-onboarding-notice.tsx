import type { ModelOnboardingNotice } from "./model-onboarding";

interface ModelOnboardingNoticeBannerProps {
  readonly notice: ModelOnboardingNotice | undefined;
  readonly onOpenSettings: (section: ModelOnboardingNotice["actionSection"]) => void;
}

export function ModelOnboardingNoticeBanner({
  notice,
  onOpenSettings,
}: ModelOnboardingNoticeBannerProps) {
  if (!notice) {
    return null;
  }

  return (
    <div className="model-onboarding-notice" data-testid="model-onboarding-notice">
      <div className="model-onboarding-notice__body">
        <div className="model-onboarding-notice__title">{notice.title}</div>
        <div className="model-onboarding-notice__description">{notice.description}</div>
      </div>
      <button
        className="button"
        type="button"
        onClick={() => onOpenSettings(notice.actionSection)}
      >
        {notice.actionLabel}
      </button>
    </div>
  );
}
