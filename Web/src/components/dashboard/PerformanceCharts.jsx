import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer
} from "recharts";
import { TrendingUp } from "lucide-react";
import { format, parseISO } from "date-fns";
import { ptBR } from "date-fns/locale";
import { api } from "@/api/client";

// Formata a série diária real (já agregada em SQL por my_daily_stats) para o formato dos
// gráficos — nenhum número aqui é calculado ou estimado, só formatado para exibição.
function formatDailyStats(rows) {
  return rows.map((row) => {
    const date = parseISO(row.day);
    return {
      date,
      label: format(date, "dd/MM"),
      shortLabel: format(date, "d MMM", { locale: ptBR }),
      views: Number(row.views) || 0,
      contacts: Number(row.contacts) || 0,
    };
  });
}

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white border border-slate-100 rounded-card shadow-lg p-3 text-xs dark:bg-slate-900 dark:border-slate-700">
      <p className="font-semibold text-slate-700 dark:text-slate-200 mb-1.5">{label}</p>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: p.color }} />
          <span className="text-slate-500 dark:text-slate-400">{p.name}:</span>
          <span className="font-semibold text-slate-800 dark:text-slate-100">{p.value}</span>
        </div>
      ))}
    </div>
  );
};

export default function PerformanceCharts({ userId, hasSuppliers }) {
  const { data: rawStats = [] } = useQuery({
    queryKey: ["my-daily-stats", userId],
    queryFn: () => api.metrics.getMyDailyStats(30),
    enabled: !!userId && !!hasSuppliers,
  });

  const data = formatDailyStats(rawStats);

  // Soma dos últimos 30 dias
  const totalViews = data.reduce((s, d) => s + d.views, 0);
  const totalContacts = data.reduce((s, d) => s + d.contacts, 0);

  // Pega só semanas (a cada 7 dias) para o eixo X sem ficar lotado
  const tickIndices = [0, 6, 13, 20, 29];

  if (!hasSuppliers || data.length === 0) return null;

  return (
    <div className="space-y-4 mb-6">
      {/* Cabeçalho da seção */}
      <div className="flex items-center gap-2">
        <TrendingUp className="w-5 h-5 text-orange-500" />
        {/* dark:text: sem ele o título ficava escuro sobre fundo escuro,
            invisível no modo escuro. */}
        <h2 className="text-lg font-bold text-slate-900 dark:text-slate-50">Desempenho — Últimos 30 dias</h2>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        {/* Gráfico de Visualizações */}
        <Card className="rounded-card border border-slate-200 shadow-none dark:border-slate-800">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-bold text-slate-700 dark:text-slate-200">
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-orange-500" />
              Visualizações
              <span className="tnum ml-auto font-display text-xl font-black text-slate-900 dark:text-slate-50">{totalViews.toLocaleString("pt-BR")}</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <ResponsiveContainer width="100%" height={180}>
              <AreaChart data={data} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="viewsGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#F94F0C" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#F94F0C" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#E6DFD8" vertical={false} />
                <XAxis
                  dataKey="shortLabel"
                  tick={{ fontSize: 11, fill: "#AFA298" }}
                  tickLine={false}
                  axisLine={false}
                  ticks={tickIndices.map((i) => data[i]?.shortLabel)}
                />
                <YAxis tick={{ fontSize: 11, fill: "#AFA298" }} tickLine={false} axisLine={false} />
                <Tooltip content={<CustomTooltip />} />
                <Area
                  type="monotone"
                  dataKey="views"
                  name="Visualizações"
                  stroke="#F94F0C"
                  strokeWidth={2}
                  fill="url(#viewsGrad)"
                  dot={false}
                  activeDot={{ r: 4, fill: "#F94F0C" }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Gráfico de Contatos */}
        <Card className="rounded-card border border-slate-200 shadow-none dark:border-slate-800">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-bold text-slate-700 dark:text-slate-200">
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-slate-700 dark:bg-slate-300" />
              Contatos Recebidos
              <span className="tnum ml-auto font-display text-xl font-black text-slate-900 dark:text-slate-50">{totalContacts}</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={data} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E6DFD8" vertical={false} />
                <XAxis
                  dataKey="shortLabel"
                  tick={{ fontSize: 11, fill: "#AFA298" }}
                  tickLine={false}
                  axisLine={false}
                  ticks={tickIndices.map((i) => data[i]?.shortLabel)}
                />
                <YAxis tick={{ fontSize: 11, fill: "#AFA298" }} tickLine={false} axisLine={false} allowDecimals={false} />
                <Tooltip content={<CustomTooltip />} />
                <Bar
                  dataKey="contacts"
                  name="Contatos"
                  fill="#6B5F57"
                  radius={[4, 4, 0, 0]}
                  maxBarSize={20}
                />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      {/* O "Visão Geral Combinada" que ficava aqui SAIU (seção 162): eram
          exatamente as duas séries dos gráficos de cima, de novo, com dois
          eixos Y de escalas diferentes -- e a linha de base de uma delas
          riscava as datas do eixo X. Repetir o dado não acrescentava nada. */}
    </div>
  );
}