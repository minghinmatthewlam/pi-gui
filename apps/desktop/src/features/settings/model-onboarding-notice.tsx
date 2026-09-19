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
        <span className="model-onboarding-notice__title">{notice.title}</span>
        <span className="model-onboarding-notice__description">{notice.description}</span>
      </div>
      <button
        className="model-onboarding-notice__action"
        type="button"
        onClick={() => onOpenSettings(notice.actionSection)}
      >
        {notice.actionLabel}
      </button>
    </div>
  );
}
