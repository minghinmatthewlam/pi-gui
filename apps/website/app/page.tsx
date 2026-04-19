import {
  HERO_BETA_NOTE,
  OG_IMAGE_PATH,
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_URL,
} from "./site";

const GITHUB_URL = "https://github.com/minghinmatthewlam/pi-gui";
const RELEASES_URL = "https://github.com/minghinmatthewlam/pi-gui/releases/latest";
const PI_MONO_URL = "https://github.com/mariozechner/pi";

const softwareApplicationJsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: SITE_NAME,
  applicationCategory: "DeveloperApplication",
  operatingSystem: "macOS",
  description: SITE_DESCRIPTION,
  url: SITE_URL,
  sameAs: [GITHUB_URL],
  image: `${SITE_URL}${OG_IMAGE_PATH}`,
  isAccessibleForFree: true,
};

function GitHubIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
    </svg>
  );
}

function BoltIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function WrenchIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 13L13 3M13 3H6M13 3v7" />
    </svg>
  );
}

export default function Page() {
  return (
    <>
      {/* ===== Nav ===== */}
      <nav className="nav">
        <div className="nav-inner">
          <span className="nav-logo">pi-gui</span>
          <div className="nav-links">
            <a href="#features" className="nav-link">
              Features
            </a>
            <a href="#get-started" className="nav-link">
              Setup
            </a>
            <a href="#architecture" className="nav-link">
              Architecture
            </a>
            <a
              href={GITHUB_URL}
              className="nav-link nav-link--github"
              target="_blank"
              rel="noopener noreferrer"
            >
              <GitHubIcon />
              GitHub
            </a>
          </div>
        </div>
      </nav>

      <main>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(softwareApplicationJsonLd),
          }}
        />
        {/* ===== Hero ===== */}
        <section className="hero">
          <div className="container">
            <div className="hero-mark" aria-hidden="true">
              &pi;
            </div>
            <h1 className="hero-heading">
              A native desktop for
              <br />
              AI coding agents
            </h1>
            <p className="hero-subtitle">
              pi-gui is a Codex-style macOS desktop app for the{" "}
              <a
                href={PI_MONO_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-link"
              >
                pi coding agent
              </a>
              . Manage workspaces, run sessions, and review agent work — all
              from a native interface.
            </p>
            <p className="hero-note">
              {HERO_BETA_NOTE}
            </p>
            <div className="hero-ctas">
              <a
                href={RELEASES_URL}
                className="btn btn-primary btn-github"
                target="_blank"
                rel="noopener noreferrer"
              >
                <GitHubIcon />
                Download Beta
              </a>
              <a href="#get-started" className="btn btn-secondary">
                Install Options
              </a>
            </div>
          </div>
          <div className="screenshot-wrapper">
            <div className="screenshot-frame">
              <div className="screenshot-titlebar">
                <span className="screenshot-dot" />
                <span className="screenshot-dot" />
                <span className="screenshot-dot" />
              </div>
              <video
                autoPlay
                loop
                muted
                playsInline
                className="screenshot-img"
                width={1480}
                height={924}
              >
                <source src="/demo.mp4" type="video/mp4" />
              </video>
            </div>
          </div>
        </section>

        {/* ===== Value Prop ===== */}
        <section className="value-prop">
          <div className="container container--narrow">
            <p>
              From quick fixes to complex refactors, pi-gui gives you a
              persistent desktop workspace for AI-powered coding sessions —
              with full visibility into what the agent is doing and why.
            </p>
          </div>
        </section>

        {/* ===== Features ===== */}
        <section id="features" className="features">
          <div className="container">
            <p className="section-eyebrow">Features</p>
            <h2 className="section-heading">
              Everything you need in one window
            </h2>
            <p className="section-subtitle">
              A desktop-native experience built for multi-project AI coding
              workflows.
            </p>
            <div className="features-grid">
              <div className="feature-card">
                <div className="feature-icon" aria-hidden="true"><FolderIcon /></div>
                <h3>Multi-workspace sessions</h3>
                <p>
                  Open project folders as workspaces, each with independent
                  session histories. Context-switch between projects without
                  losing state.
                </p>
              </div>
              <div className="feature-card">
                <div className="feature-icon" aria-hidden="true"><BoltIcon /></div>
                <h3>Real-time agent timeline</h3>
                <p>
                  Watch every tool execution, code change, and reasoning step in
                  a scrollable timeline with full input and output detail.
                </p>
              </div>
              <div className="feature-card">
                <div className="feature-icon" aria-hidden="true"><ClockIcon /></div>
                <h3>Persistent session history</h3>
                <p>
                  Sessions survive restarts. Resume any previous conversation,
                  review transcripts, and continue exactly where you left off.
                </p>
              </div>
              <div className="feature-card">
                <div className="feature-icon" aria-hidden="true"><WrenchIcon /></div>
                <h3>Skills &amp; slash commands</h3>
                <p>
                  Extend pi-gui with workspace-specific skills and slash
                  commands for model switching, thinking levels, settings, and
                  custom workflows.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* ===== Architecture ===== */}
        <section id="architecture" className="architecture">
          <div className="container">
            <p className="section-eyebrow">Architecture</p>
            <h2 className="section-heading">Built for durability</h2>
            <p className="architecture-desc">
              The desktop shell is separated from the agent runtime through a
              durable SessionDriver interface — making the frontend independent
              of backend changes and ready for future runtime swaps. Built on
              top of{" "}
              <a
                href={PI_MONO_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-link"
              >
                @mariozechner/pi-coding-agent
              </a>
              .
            </p>
            <div className="tech-stack">
              <span className="tech-chip">Electron 34</span>
              <span className="tech-chip">React 19</span>
              <span className="tech-chip">TypeScript</span>
              <span className="tech-chip">Vite</span>
              <span className="tech-chip">pi-coding-agent</span>
            </div>
            <div className="diagram">
              <div className="diagram-row">
                <span className="diagram-label">Renderer</span>
                <span className="diagram-arrow">&rarr;</span>
                React UI &middot; Session views &middot; Composer
              </div>
              <div className="diagram-row">
                <span className="diagram-label">Preload</span>
                <span className="diagram-arrow">&rarr;</span>
                Secure IPC bridge
              </div>
              <div className="diagram-row">
                <span className="diagram-label">Main</span>
                <span className="diagram-arrow">&rarr;</span>
                SessionDriver &middot; Catalogs &middot; Persistence
              </div>
              <div className="diagram-row">
                <span className="diagram-label">Runtime</span>
                <span className="diagram-arrow">&rarr;</span>
                pi-coding-agent &middot; Model providers
              </div>
            </div>
          </div>
        </section>

        {/* ===== Get Started ===== */}
        <section id="get-started" className="get-started">
          <div className="container">
            <p className="section-eyebrow">Get started</p>
            <h2 className="section-heading">Install the beta your way</h2>
            <div className="code-block">
              <code>
                <span className="code-comment"># Direct install from GitHub Releases</span>
                {"\n"}
                <span className="code-command">open</span>{" "}
                {RELEASES_URL}
                {"\n\n"}
                <span className="code-comment"># Or install with Homebrew</span>
                {"\n"}
                <span className="code-command">brew tap</span>{" "}
                minghinmatthewlam/tap
                {"\n"}
                <span className="code-command">brew install --cask</span>{" "}
                pi-gui
                {"\n\n"}
                <span className="code-comment"># Later, update the Homebrew install</span>
                {"\n"}
                <span className="code-command">brew upgrade --cask</span>{" "}
                pi-gui
                {"\n\n"}
                <span className="code-comment"># Source install is for local development</span>
                {"\n"}
                <span className="code-command">git clone</span>{" "}
                {GITHUB_URL}.git{"\n"}
                <span className="code-command">cd</span> pi-gui{"\n\n"}
                <span className="code-comment"># Install dependencies and run</span>
                {"\n"}
                <span className="code-command">pnpm install</span>
                {"\n"}
                <span className="code-command">pnpm dev</span>
              </code>
            </div>
            <p className="section-subtitle">
              DMG installs update from GitHub Releases. Homebrew installs update
              with <code>brew upgrade --cask pi-gui</code>. During beta,
              Homebrew upgrades may require re-confirming some macOS permissions
              or Dock placement after reinstall-style updates.
            </p>
            <div className="hero-ctas">
              <a
                href={RELEASES_URL}
                className="btn btn-primary btn-github"
                target="_blank"
                rel="noopener noreferrer"
              >
                <GitHubIcon />
                Open Releases
                <ArrowIcon />
              </a>
              <a
                href={GITHUB_URL}
                className="btn btn-secondary"
                target="_blank"
                rel="noopener noreferrer"
              >
                View Source
              </a>
            </div>
          </div>
        </section>
      </main>

      {/* ===== Footer ===== */}
      <footer className="footer">
        <div className="footer-inner">
          <span>pi-gui</span>
          <span className="footer-sep">&middot;</span>
          <span>MIT License</span>
          <span className="footer-sep">&middot;</span>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub
          </a>
          <span className="footer-sep">&middot;</span>
          <span className="footer-credit">
            Built on{" "}
            <a
              href={PI_MONO_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              pi
            </a>
          </span>
        </div>
      </footer>
    </>
  );
}
