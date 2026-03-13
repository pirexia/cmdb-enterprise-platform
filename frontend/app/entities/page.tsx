import { Building2, Construction } from "lucide-react";

export default function EntitiesPage() {
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white px-8 py-5">
        <div className="flex items-center gap-3">
          <Building2 className="h-5 w-5 text-slate-400" />
          <div>
            <h1 className="text-xl font-bold text-slate-900">Entidades</h1>
            <p className="text-sm text-slate-500 mt-0.5">
              Proveedores, Ubicaciones y Centros de Coste
            </p>
          </div>
        </div>
      </header>

      <div className="px-8 py-8 max-w-4xl mx-auto">
        {/* Category Cards */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 mb-10">
          {[
            { label: "Proveedores",       desc: "Fabricantes y distribuidores",       color: "bg-blue-50 text-blue-600",    border: "border-blue-200" },
            { label: "Ubicaciones",       desc: "Sites, Datacenters y Racks",         color: "bg-green-50 text-green-600",  border: "border-green-200" },
            { label: "Centros de Coste",  desc: "Unidades de negocio y proyectos",    color: "bg-purple-50 text-purple-600", border: "border-purple-200" },
          ].map(({ label, desc, color, border }) => (
            <div
              key={label}
              className={`rounded-2xl border ${border} ${color.split(" ")[0]} p-5`}
            >
              <p className={`text-sm font-semibold ${color.split(" ")[1]}`}>{label}</p>
              <p className="mt-1 text-xs text-slate-500">{desc}</p>
            </div>
          ))}
        </div>

        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-amber-100 mb-6">
            <Construction className="h-8 w-8 text-amber-500" />
          </div>
          <h2 className="text-lg font-semibold text-slate-700 mb-2">Próximamente</h2>
          <p className="text-sm text-slate-500 max-w-md">
            La gestión de entidades estará disponible en la próxima versión.
            Podrás administrar proveedores, jerarquías de ubicaciones y centros de coste asociados a los CIs.
          </p>
        </div>
      </div>
    </div>
  );
}
