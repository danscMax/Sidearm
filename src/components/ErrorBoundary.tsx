import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary] Uncaught render error:", error, info);
  }

  handleReload = () => {
    // Full webview reload: resets React state and re-reads config from disk.
    // Merely clearing hasError would re-render the same tree that just crashed.
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-boundary">
          <h2 className="error-boundary__title">
            Произошла непредвиденная ошибка
          </h2>
          <pre className="error-boundary__pre">
            {this.state.error?.message ?? "Unknown error"}
          </pre>
          <button
            onClick={this.handleReload}
            className="error-boundary__reload"
          >
            Перезагрузить
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
