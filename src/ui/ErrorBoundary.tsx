import React from "react";
import { logger } from "../lib/logger";

type Props = {
  label: string;
  children: React.ReactNode;
};

type State = {
  error: Error | null;
};

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    logger.error(`React ErrorBoundary: ${this.props.label}`, error, { componentStack: info.componentStack });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="error-boundary">
        <strong>{this.props.label}组件异常</strong>
        <span>{this.state.error.message}</span>
        <button onClick={() => this.setState({ error: null })}>刷新当前组件</button>
      </div>
    );
  }
}
