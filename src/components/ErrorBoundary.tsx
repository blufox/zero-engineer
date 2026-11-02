import { Component, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

/**
 * Contains a crash to the page it happened in: the sidebar and other pages keep working.
 * Layout gives it `key={pathname}`, so navigating away resets it.
 */
export default class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("Page crashed:", error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="grid h-full place-items-center p-8">
        <div className="max-w-md rounded-lg border border-danger/40 bg-surface p-6 text-center">
          <AlertTriangle size={24} className="mx-auto mb-3 text-danger" />
          <p className="mb-1 font-medium">This page hit an error</p>
          <p className="mb-4 break-words font-mono text-xs text-muted">{this.state.error.message}</p>
          <button onClick={() => this.setState({ error: null })}
            className="rounded-md border border-line bg-surface-2 px-3 py-1.5 text-sm hover:border-muted">
            Try again
          </button>
        </div>
      </div>
    );
  }
}
