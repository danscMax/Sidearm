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
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: "100vh",
            gap: "16px",
            padding: "24px",
            fontFamily: "system-ui, sans-serif",
            color: "#c8d0b8",
            backgroundColor: "#1a1f16",
          }}
        >
          <h2 style={{ margin: 0 }}>
            Произошла непредвиденная ошибка
          </h2>
          <pre
            style={{
              maxWidth: "600px",
              maxHeight: "200px",
              overflow: "auto",
              padding: "12px",
              borderRadius: "6px",
              backgroundColor: "#242a1e",
              fontSize: "12px",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {this.state.error?.message ?? "Unknown error"}
          </pre>
          <button
            onClick={this.handleReload}
            style={{
              padding: "8px 24px",
              borderRadius: "6px",
              border: "1px solid #4a5240",
              backgroundColor: "#2a3124",
              color: "#c8d0b8",
              cursor: "pointer",
              fontSize: "14px",
            }}
          >
            Перезагрузить
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
