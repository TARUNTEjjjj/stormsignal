import { Component, type ReactNode } from 'react';

export default class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <main className="fatal">
        <h1>StormSignal needs a reload</h1>
        <p>
          Live information is unavailable in this view. Check your official weather authority for
          current warnings.
        </p>
        <button onClick={() => location.reload()}>Reload dashboard</button>
        <a href="/preparedness.html">Open preparedness checklist</a>
      </main>
    ) : (
      this.props.children
    );
  }
}
