import React from "react";
import UserContext from "./UserContext";

import { ApiHelper, ErrorMessages, Locale } from "@churchapps/apphelper";
import { Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";

import { EnvironmentHelper } from "./helpers/EnvironmentHelper";
import { CloudflareLogin } from "./cloudflare/CloudflareLogin";
import { CloudflareApp } from "./cloudflare/CloudflareApp";




import { type ErrorLogInterface, type ErrorAppDataInterface } from "@churchapps/helpers";
import { AnalyticsHelper } from "./helpers";
import { UserHelper, ErrorHelper } from "@churchapps/apphelper";
import { Pingback } from "./Pingback";
import { queryClient } from "./queryClient";

const MemberPortal = React.lazy(() => import("./cloudflare/MemberPortal"));
const Login = React.lazy(() => import("./Login").then(m => ({ default: m.Login })));
const Authenticated = React.lazy(() => import("./Authenticated").then(m => ({ default: m.Authenticated })));
const Logout = React.lazy(() => import("./Logout").then(m => ({ default: m.Logout })));
const OAuthCallback = React.lazy(() => import("./oauth/OAuthCallback").then(m => ({ default: m.OAuthCallback })));

const isSessionExpired = () => {
  try {
    const jwt = ApiHelper.getConfig("MembershipApi")?.jwt;
    if (!jwt) return true;
    const payload = JSON.parse(atob(jwt.split(".")[1]));
    return typeof payload.exp === "number" && payload.exp * 1000 < Date.now();
  } catch {
    return false;
  }
};

// Kept out of ControlPanel: re-rendering ControlPanel remounts the whole page tree,
// so an API error would wipe whatever the user was editing.
const ApiErrorBanner = () => {
  const [errors, setErrors] = React.useState<string[]>([]);
  const location = useLocation();
  const navigate = useNavigate();

  const navigateRef = React.useRef(navigate);
  navigateRef.current = navigate;
  const pathRef = React.useRef(location.pathname);
  pathRef.current = location.pathname;
  // Dedupe identical errors within a short window so a failing page effect that
  // refires can't spin the handler into an infinite loop.
  const lastErrorRef = React.useRef<{ key: string; time: number }>({ key: "", time: 0 });
  const redirectingRef = React.useRef(false);

  // Re-arm the 401 redirect guard once the user lands back on the login screen.
  React.useEffect(() => {
    if (location.pathname.startsWith("/login")) redirectingRef.current = false;
    if (EnvironmentHelper.isCloudflare) setErrors([]);
  }, [location.pathname]);

  const getErrorAppData = React.useCallback((): ErrorAppDataInterface => ({
    churchId: UserHelper.currentUserChurch?.church?.id || "",
    userId: UserHelper.user?.id || "",
    originUrl: typeof window === "undefined" ? "" : window.location.toString(),
    application: "B1Admin"
  }), []);

  React.useEffect(() => {
    const handler = (error: ErrorLogInterface) => {
      try {
        const type = error.errorType || "";
        const key = type + "|" + (error.message || "");
        const now = Date.now();
        if (lastErrorRef.current.key === key && now - lastErrorRef.current.time < 5000) return;
        lastErrorRef.current = { key, time: now };

        if (type === "401") {
          if (EnvironmentHelper.isCloudflare) {
            ApiHelper.clearPermissions();
            queryClient.clear();
            navigateRef.current("/login", { replace: true });
            return;
          }
          // APIs also return 401 for permission denials on a live session; only an
          // expired/missing session token means the user actually needs to re-login.
          if (!isSessionExpired()) return;
          if (redirectingRef.current) return;
          const p = pathRef.current || "";
          if (p.startsWith("/login") || p.startsWith("/logout") || p.startsWith("/oauth")) return;
          redirectingRef.current = true;
          navigateRef.current("/logout");
          return;
        }
        if (type.startsWith("5")) setErrors([Locale.label("controlPanel.serverError")]);
        // ErrorHelper puts the request url in `message` and the server's text in `details`.
        else if (error.details || error.message) {
          let msg = String(error.details || error.message);
          try {
            const parsed = JSON.parse(msg);
            if (typeof parsed?.error === "string" && parsed.error) msg = parsed.error;
            else if (Array.isArray(parsed?.errors) && parsed.errors[0]) msg = String(parsed.errors[0]);
          } catch { /* already a plain string */ }
          setErrors([msg]);
        }
      } catch {
        // Never let the error handler throw — that would re-enter error logging.
      }
    };
    ErrorHelper.init(getErrorAppData, handler);
    return () => { ErrorHelper.init(getErrorAppData, () => {}); };
  }, [getErrorAppData]);

  return <ErrorMessages errors={errors} />;
};

export const ControlPanel = () => {
  const location = useLocation();

  React.useEffect(() => {
    AnalyticsHelper.init();
    AnalyticsHelper.logPageView();
  }, [location]);

  React.useContext(UserContext); //to force rerender on login
  return (
    <>
      <ApiErrorBanner />
      <React.Suspense fallback={<div>Loading…</div>}>
      <Routes>
        <Route path="/portal/*" element={<MemberPortal />} />
        <Route path="/pingback" element={<Pingback />} />
        <Route path="/logout" element={EnvironmentHelper.isCloudflare ? <Navigate to="/" replace /> : <Logout />} />
        <Route path="/login" element={EnvironmentHelper.isCloudflare ? <CloudflareLogin /> : <Login />} />
        <Route path="/oauth/callback" element={EnvironmentHelper.isCloudflare ? <Navigate to="/" replace /> : <OAuthCallback />} />
        <Route
          path="/*"
          element={
            <RequireAuth>
              {EnvironmentHelper.isCloudflare ? <CloudflareApp /> : <Authenticated />}
            </RequireAuth>
          }
        />
      </Routes>
      </React.Suspense>
    </>
  );
};

const RequireAuth = ({ children }: { children: JSX.Element }) => {
  const location = useLocation();
  if (!ApiHelper.isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return children;
};
