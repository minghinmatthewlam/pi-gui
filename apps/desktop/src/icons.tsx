import type { ReactNode } from "react";

function Icon({ children }: { readonly children: ReactNode }) {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 20 20">
      {children}
    </svg>
  );
}

export function PlusIcon() {
  return (
    <Icon>
      <path d="M10 4.25v11.5M4.25 10h11.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
    </Icon>
  );
}

export function ArrowUpIcon() {
  return (
    <Icon>
      <path d="M10 15.2V4.8" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
      <path d="M5.8 9 10 4.8 14.2 9" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </Icon>
  );
}

export function StopSquareIcon() {
  return (
    <Icon>
      <rect x="5.2" y="5.2" width="9.6" height="9.6" rx="1.6" fill="currentColor" />
    </Icon>
  );
}

export function FolderIcon() {
  return (
    <Icon>
      <path
        d="M2.75 6.5a1.75 1.75 0 0 1 1.75-1.75h3.1l1.5 1.7h6.4a1.75 1.75 0 0 1 1.75 1.75v5.3a1.75 1.75 0 0 1-1.75 1.75H4.5a1.75 1.75 0 0 1-1.75-1.75V6.5Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </Icon>
  );
}

export function ArchiveIcon() {
  return (
    <Icon>
      <path
        d="M4.1 5.1h11.8l-.8 10.1a1.2 1.2 0 0 1-1.2 1.1H6.1a1.2 1.2 0 0 1-1.2-1.1L4.1 5.1Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.35"
      />
      <path d="M3.4 4.1h13.2v2.4H3.4zM7.1 9.15h5.8" stroke="currentColor" strokeLinecap="round" strokeWidth="1.35" />
    </Icon>
  );
}

export function RestoreIcon() {
  return (
    <Icon>
      <path
        d="M4.1 6.15h11.8l-.8 9.05a1.2 1.2 0 0 1-1.2 1.1H6.1a1.2 1.2 0 0 1-1.2-1.1L4.1 6.15Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.35"
      />
      <path d="M3.4 5.15h13.2v2.1H3.4z" stroke="currentColor" strokeWidth="1.35" />
      <path d="M10 12.8V8.4m0 0L8.2 10.2M10 8.4l1.8 1.8" stroke="currentColor" strokeLinecap="round" strokeWidth="1.35" />
    </Icon>
  );
}

export function ChevronDownIcon() {
  return (
    <Icon>
      <path d="m5.7 8.1 4.3 4.1 4.3-4.1" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
    </Icon>
  );
}

export function ChevronRightIcon() {
  return (
    <Icon>
      <path d="m8.1 5.7 4.1 4.3-4.1 4.3" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
    </Icon>
  );
}

export function CopyIcon() {
  return (
    <Icon>
      <rect x="6.5" y="6.5" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
      <path d="M4.5 13.5V5a1.5 1.5 0 0 1 1.5-1.5h8.5" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" />
    </Icon>
  );
}

export function SparkIcon() {
  return (
    <Icon>
      <path
        d="m10 3.1 1.55 3.66 3.66 1.55-3.66 1.55L10 13.5l-1.55-3.64L4.8 8.3l3.65-1.55L10 3.1Zm5 8.6.72 1.58 1.58.72-1.58.72L15 16.3l-.72-1.58-1.58-.72 1.58-.72.72-1.58Z"
        fill="currentColor"
      />
    </Icon>
  );
}

export function SettingsIcon() {
  return (
    <Icon>
      <path
        d="M8.8 3.6h2.4l.4 1.6 1.5.62 1.42-.85 1.7 1.7-.86 1.43.63 1.5 1.6.4v2.4l-1.6.4-.63 1.5.86 1.43-1.7 1.7-1.42-.85-1.5.62-.4 1.6H8.8l-.4-1.6-1.5-.62-1.42.85-1.7-1.7.86-1.43-.63-1.5-1.6-.4v-2.4l1.6-.4.63-1.5-.86-1.43 1.7-1.7 1.42.85 1.5-.62.4-1.6Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.25"
      />
      <circle cx="10" cy="10" r="2.3" stroke="currentColor" strokeWidth="1.25" />
    </Icon>
  );
}

export function ModelIcon() {
  return (
    <Icon>
      <path
        d="M10 3.3 15.8 6.4v7.2L10 16.7 4.2 13.6V6.4L10 3.3Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.4"
      />
      <path d="M4.5 6.65 10 9.7l5.5-3.05M10 9.8v6.5" stroke="currentColor" strokeWidth="1.2" />
    </Icon>
  );
}

export function ReasoningIcon() {
  return (
    <Icon>
      <path
        d="M7.2 6.1a2.6 2.6 0 1 1 2.6 2.6v1.05M12.35 6.35a2.2 2.2 0 1 1-2.2-2.2"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.35"
      />
      <path d="M7.2 13.6h5.6M8.2 16h3.6" stroke="currentColor" strokeLinecap="round" strokeWidth="1.35" />
    </Icon>
  );
}

export function StatusIcon() {
  return (
    <Icon>
      <path d="M4.3 10h11.4" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" />
      <path d="M10 4.3v11.4" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" />
      <circle cx="10" cy="10" r="6.6" stroke="currentColor" strokeWidth="1.3" />
    </Icon>
  );
}

export function SkillIcon() {
  return (
    <Icon>
      <path
        d="M10 2.8 15.8 6v8L10 17.2 4.2 14V6L10 2.8Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.35"
      />
      <path d="M10 2.8V17.2M4.2 6 10 9.2 15.8 6" stroke="currentColor" strokeWidth="1.2" />
    </Icon>
  );
}

export function RefreshIcon() {
  return (
    <Icon>
      <path
        d="M15.1 8.2A5.6 5.6 0 1 0 15 12.8M15.2 4.9v3.7h-3.7"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.45"
      />
    </Icon>
  );
}

export function WorktreeIcon() {
  return (
    <Icon>
      <path d="M6 5.3h8.1v8.1" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.45" />
      <path d="M13.9 5.45 5.9 13.45" stroke="currentColor" strokeLinecap="round" strokeWidth="1.45" />
      <path d="M5.85 9.75v3.95h3.95" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.45" />
    </Icon>
  );
}

export function DiffIcon() {
  return (
    <Icon>
      <path d="M7 7h6M7 10h4M7 13h5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.3" />
      <rect x="4" y="4" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.3" fill="none" />
    </Icon>
  );
}
