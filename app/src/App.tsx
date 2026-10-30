import { Component, type ReactNode } from "react";
import { Header } from "./components/Header";
import { useRoute } from "./hooks";
import { AccessPage } from "./pages/Access";
import { BuilderPage } from "./pages/Builder";
import { PositionsPage } from "./pages/Positions";
import { ReviewPage } from "./pages/Review";
import { SetupPage } from "./pages/Setup";
import { AppProvider } from "./state";

/** Any render error still leaves a way to revoke (docs/SPEC.md §9.3). */
class ErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="page">
        <div className="notice danger">
          <p>Something went wrong: {this.state.error.message}</p>
          <p>
            <a href="#/revoke" onClick={() => this.setState({ error: undefined })}>
              Open Revoke
            </a>{" "}
            · <a href="#/" onClick={() => this.setState({ error: undefined })}>Back to positions</a>
          </p>
        </div>
      </main>
    );
  }
}

function Routes() {
  const { path, params } = useRoute();
  switch (path) {
    case "/access":
      return <AccessPage />;
    case "/setup":
      return <SetupPage />;
    case "/builder":
      return <BuilderPage params={params} key={params.get("flow") ?? "draft"} />;
    case "/review":
      return <ReviewPage params={params} key={params.toString()} />;
    default:
      return <PositionsPage />;
  }
}

export function App() {
  return (
    <AppProvider>
      <Header />
      <main className="page">
        <ErrorBoundary>
          <Routes />
        </ErrorBoundary>
      </main>
    </AppProvider>
  );
}
