import { Component, lazy, Suspense, type ReactNode } from "react";
import { Header } from "./components/Header";
import { useRoute } from "./hooks";
import { PositionsPage } from "./pages/Positions";

// Positions is the landing page; everything else loads on first visit.
const AccessPage = lazy(() => import("./pages/Access").then((m) => ({ default: m.AccessPage })));
const BuilderPage = lazy(() => import("./pages/Builder").then((m) => ({ default: m.BuilderPage })));
const ReviewPage = lazy(() => import("./pages/Review").then((m) => ({ default: m.ReviewPage })));
const SetupPage = lazy(() => import("./pages/Setup").then((m) => ({ default: m.SetupPage })));
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
          <Suspense fallback={<p className="muted">Loading…</p>}>
            <Routes />
          </Suspense>
        </ErrorBoundary>
      </main>
    </AppProvider>
  );
}
