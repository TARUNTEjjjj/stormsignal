import { Component, Suspense, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  label: string;
  onUseEssentials: () => void;
  /** A class for the notice that replaces the tool, so it can take the tool's place in the page. */
  className?: string;
}

/** An optional download must never take the emergency tools off the screen. */
export default class OptionalPanel extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <section
          className={this.props.className ? `panel ${this.props.className}` : 'panel'}
          role="alert"
        >
          <h3>{this.props.label} unavailable</h3>
          <p>
            This optional tool could not load. Your essential forecast, saved briefings, and
            emergency kit remain available. Live information still needs a working connection.
          </p>
          <p>Once your connection returns, reload the dashboard to retry this download.</p>
          <div className="optional-actions">
            <button className="secondary-button" onClick={() => location.reload()}>
              Reload dashboard
            </button>
            <button className="secondary-button" onClick={this.props.onUseEssentials}>
              Use data saver
            </button>
            <a href="/offline.html">Open emergency kit</a>
          </div>
        </section>
      );
    }
    return (
      <Suspense
        fallback={
          <p className="panel" role="status">
            Loading {this.props.label.toLowerCase()}…
          </p>
        }
      >
        {this.props.children}
      </Suspense>
    );
  }
}

/**
 * The console report of an error that a boundary caught (createRoot's onCaughtError). An optional
 * tool whose download failed is already explained on the page, with a way to retry, so it is a
 * warning there, not an error; anything else is an error, as React reports it.
 */
export function reportCaughtError(
  error: unknown,
  info: { errorBoundary?: unknown },
  log: Pick<Console, 'warn' | 'error'> = console,
) {
  if (info.errorBoundary instanceof OptionalPanel)
    log.warn(
      `StormSignal: an optional tool could not load: ${error instanceof Error ? error.message : String(error)}`,
    );
  else log.error(error);
}
