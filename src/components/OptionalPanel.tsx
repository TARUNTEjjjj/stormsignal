import { Component, Suspense, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  label: string;
  onUseEssentials: () => void;
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
        <section className="panel" role="alert">
          <h3>{this.props.label} unavailable</h3>
          <p>
            This optional tool could not load. Your essential forecast, saved briefings, and
            emergency kit remain available. Live information still needs a working connection.
          </p>
          <button className="secondary-button" onClick={this.props.onUseEssentials}>
            Use data saver
          </button>{' '}
          <a href="/offline.html">Open emergency kit</a>
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
