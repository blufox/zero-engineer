import { useEffect, useState } from "react";
import { HashRouter, Route, Routes } from "react-router-dom";
import Layout from "./app/Layout";
import Onboarding from "./app/Onboarding";
import { MODULES } from "./app/modules";
import HomePage from "./modules/home/HomePage";
import Placeholder from "./modules/Placeholder";
import SettingsPage from "./modules/settings/SettingsPage";
import ToolsPage from "./modules/tools/ToolsPage";
import CheatSheetsPage from "./modules/cheatsheets/CheatSheetsPage";
import SnippetsPage from "./modules/snippets/SnippetsPage";
import ReposPage from "./modules/repos/ReposPage";
import ServersPage from "./modules/servers/ServersPage";
import GlossaryPage from "./modules/glossary/GlossaryPage";
import ConfigsPage from "./modules/configs/ConfigsPage";
import { SettingsProvider } from "./lib/settings";
import { errorMessage, storage, type AppConfig } from "./lib/storage";

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    storage.getAppConfig().then(setConfig).catch((e) => setError(errorMessage(e)));
  }, []);

  if (error) return <p className="p-8 text-danger">Failed to start: {error}</p>;
  if (!config) return null;
  if (!config.dataDir) return <Onboarding onDone={setConfig} />;

  return (
    // key: remount everything (reload settings) when the data folder changes
    <SettingsProvider key={config.dataDir}>
      <HashRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<HomePage />} />
            <Route path="tools/:toolId?" element={<ToolsPage />} />
            <Route path="cheatsheets/:sheetId?" element={<CheatSheetsPage />} />
            <Route path="snippets/:snippetId?" element={<SnippetsPage />} />
            <Route path="repos" element={<ReposPage />} />
            <Route path="servers" element={<ServersPage />} />
            <Route path="glossary/:entryId?" element={<GlossaryPage />} />
            <Route path="configs" element={<ConfigsPage />} />
            <Route
              path="settings"
              element={<SettingsPage dataDir={config.dataDir}
                onDataDirChange={(dataDir) => setConfig({ dataDir })} />}
            />
            {MODULES.filter((m) => m.milestone).map((m) => (
              <Route key={m.id} path={m.path.slice(1)} element={<Placeholder mod={m} />} />
            ))}
          </Route>
        </Routes>
      </HashRouter>
    </SettingsProvider>
  );
}
