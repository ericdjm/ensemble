import { useEffect, useState } from "react";

export interface Route {
  page: "home" | "workspace" | "doctor";
  workspaceId: string | null;
}

function parse(): Route {
  if (location.hash.startsWith("#/doctor")) return { page: "doctor", workspaceId: null };
  const m = /^#\/ws\/([^/]+)/.exec(location.hash);
  return m?.[1] ? { page: "workspace", workspaceId: m[1] } : { page: "home", workspaceId: null };
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

export function navigateToDoctor(): void {
  location.hash = "#/doctor";
}
