import { Settings, Construction } from "lucide-react";

export default function SettingsPage() {
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white px-8 py-5">
        <div className="flex items-center gap-3">
          <Settings className="h-5 w-5 text-slate-400" />
          <div>
            <h1 className="text-xl font-bold text-slate-900">Configuración</h1>
            <p className="text-sm text-slate-500 mt-0.5">Ajustes de la plataforma</p>
          </div>
        </div>
      </header>

      <div className="flex flex-col items-center justify-center py-40 text-center px-8">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-amber-100 mb-6">
          <Construction className="h-8 w-8 text-amber-500" />
        </div>
        <h2 className="text-lg font-semibold text-slate-700 mb-2">Próximamente</h2>
        <p className="text-sm text-slate-500 max-w-md">
          La sección de configuración estará disponible próximamente.
          Incluirá ajustes de usuarios, roles, integraciones y parámetros del sistema.
        </p>
      </div>
    </div>
  );
}
