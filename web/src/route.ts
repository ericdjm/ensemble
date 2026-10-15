import { useEffect, useState } from "react";

export interface Route {
  workspaceId: string | null;
}

function parse(): Route {
  const m = /^#\/ws\/([^/]+)/.exec(location.hash);
  return { workspaceId: m?.[1] ?? null };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parse);
  useEffect(() => {
    const onChange = () => setRoute(parse());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export function navigateToWorkspace(id: string | null): void {
  location.hash = id ? `#/ws/${id}` : "#/";
}
