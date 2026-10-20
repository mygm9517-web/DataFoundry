import { LocaleProvider } from "../../i18n/locale-context";

/**
 * A wall is a client-only page — it reads the screen with the workspace's
 * browser credentials — but `BigScreenView` renders translated strings, so the
 * locale provider has to be mounted above it. The data-tasks page mounts its own;
 * `/wall` is not under that tree, so it mounts one here.
 */
export default function WallLayout({ children }: { children: React.ReactNode }) {
  return <LocaleProvider>{children}</LocaleProvider>;
}
