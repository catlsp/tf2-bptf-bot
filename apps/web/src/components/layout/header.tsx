import { useLocation } from 'react-router-dom';
import { titleForPath } from './nav';

export function Header(): React.JSX.Element {
  const { pathname } = useLocation();
  const title = titleForPath(pathname);

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-6">
      <h1 className="text-base font-semibold">{title}</h1>
      <a
        href="https://backpack.tf/classifieds"
        target="_blank"
        rel="noreferrer"
        className="text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        backpack.tf ↗
      </a>
    </header>
  );
}
