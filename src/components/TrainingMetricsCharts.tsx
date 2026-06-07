/**
 * Lazily-loaded recharts component for TrainingDetailsModal.
 * Keeping recharts in a separate module prevents it from being bundled into
 * the main vendor chunk and defers the ~90 KB (gzip) download until the user
 * actually opens the training-details dialog.
 */
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

interface TrainingMetrics {
  epoch: number;
  box_loss?: number;
  cls_loss?: number;
  dfl_loss?: number;
  seg_loss?: number;
  precision?: number;
  recall?: number;
  mAP50?: number;
  mAP50_95?: number;
  lr0?: number;
  lr1?: number;
  lr2?: number;
}

interface TrainingMetricsChartsProps {
  metricsHistory: TrainingMetrics[];
}

export default function TrainingMetricsCharts({ metricsHistory }: TrainingMetricsChartsProps) {
  const data = [...metricsHistory];
  const mapPoints = data.filter(
    (m) => m.mAP50 != null || m.mAP50_95 != null,
  );
  const hasNonZeroMap = mapPoints.some(
    (m) => (m.mAP50 ?? 0) > 0 || (m.mAP50_95 ?? 0) > 0,
  );

  return (
    <div className="space-y-6">
      {/* Training Losses Chart */}
      <div className="bg-card border border-border rounded-lg p-4">
        <h4 className="text-sm font-medium text-muted-foreground mb-4">Training Losses</h4>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
            <XAxis
              dataKey="epoch"
              stroke="#9CA3AF"
              tick={{ fill: "#9CA3AF", fontSize: 12 }}
              label={{ value: "Epoch", position: "insideBottom", offset: -5, fill: "#9CA3AF" }}
              domain={[0, "dataMax"]}
            />
            <YAxis
              stroke="#9CA3AF"
              tick={{ fill: "#9CA3AF", fontSize: 12 }}
              domain={[0, "auto"]}
            />
            <Tooltip
              contentStyle={{ backgroundColor: "#1F2937", border: "1px solid #374151", borderRadius: "6px" }}
              labelStyle={{ color: "#F3F4F6" }}
            />
            <Legend wrapperStyle={{ fontSize: "12px" }} />
            <Line type="monotone" dataKey="box_loss" stroke="#EF4444" name="Box Loss" strokeWidth={2} dot={{ r: 3 }} />
            <Line type="monotone" dataKey="cls_loss" stroke="#F59E0B" name="Class Loss" strokeWidth={2} dot={{ r: 3 }} />
            <Line type="monotone" dataKey="dfl_loss" stroke="#10B981" name="DFL Loss" strokeWidth={2} dot={{ r: 3 }} />
            {data.some((m) => m.seg_loss) && (
              <Line type="monotone" dataKey="seg_loss" stroke="#8B5CF6" name="Seg Loss" strokeWidth={2} dot={{ r: 3 }} />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* mAP Metrics Chart */}
      <div className="bg-card border border-border rounded-lg p-4">
        <h4 className="text-sm font-medium text-muted-foreground mb-4">mAP Metrics</h4>
        {mapPoints.length === 0 ? (
          <p className="text-sm text-muted-foreground mb-4">
            mAP is recorded on validation epochs only (every few epochs, not each training step).
            It will appear after the first MMYOLO validation pass completes.
          </p>
        ) : !hasNonZeroMap ? (
          <p className="text-sm text-amber-600 dark:text-amber-500 mb-4">
            Validation mAP is 0% on all runs so far. Metrics are being saved, but the model is not
            scoring detections on the val set — check annotations, class IDs, and the val split.
          </p>
        ) : null}
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
            <XAxis
              dataKey="epoch"
              stroke="#9CA3AF"
              tick={{ fill: "#9CA3AF", fontSize: 12 }}
              label={{ value: "Epoch", position: "insideBottom", offset: -5, fill: "#9CA3AF" }}
              domain={[0, "dataMax"]}
            />
            <YAxis
              stroke="#9CA3AF"
              tick={{ fill: "#9CA3AF", fontSize: 12 }}
              domain={[0, 1]}
              tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
            />
            <Tooltip
              contentStyle={{ backgroundColor: "#1F2937", border: "1px solid #374151", borderRadius: "6px" }}
              labelStyle={{ color: "#F3F4F6" }}
              formatter={(v: number) => `${(v * 100).toFixed(2)}%`}
            />
            <Legend wrapperStyle={{ fontSize: "12px" }} />
            <Line type="monotone" dataKey="mAP50" stroke="#10B981" name="mAP@50" strokeWidth={2} dot={{ r: 3 }} />
            <Line type="monotone" dataKey="mAP50_95" stroke="#3B82F6" name="mAP@50-95" strokeWidth={2} dot={{ r: 3 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Precision & Recall Chart */}
      <div className="bg-card border border-border rounded-lg p-4">
        <h4 className="text-sm font-medium text-muted-foreground mb-4">Precision & Recall</h4>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
            <XAxis
              dataKey="epoch"
              stroke="#9CA3AF"
              tick={{ fill: "#9CA3AF", fontSize: 12 }}
              label={{ value: "Epoch", position: "insideBottom", offset: -5, fill: "#9CA3AF" }}
              domain={[0, "dataMax"]}
            />
            <YAxis
              stroke="#9CA3AF"
              tick={{ fill: "#9CA3AF", fontSize: 12 }}
              domain={[0, 1]}
              tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
            />
            <Tooltip
              contentStyle={{ backgroundColor: "#1F2937", border: "1px solid #374151", borderRadius: "6px" }}
              labelStyle={{ color: "#F3F4F6" }}
              formatter={(v: number) => `${(v * 100).toFixed(2)}%`}
            />
            <Legend wrapperStyle={{ fontSize: "12px" }} />
            <Line type="monotone" dataKey="precision" stroke="#8B5CF6" name="Precision" strokeWidth={2} dot={{ r: 3 }} />
            <Line type="monotone" dataKey="recall" stroke="#EC4899" name="Recall" strokeWidth={2} dot={{ r: 3 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Learning Rates Chart */}
      {data.some((m) => m.lr0 || m.lr1 || m.lr2) && (
        <div className="bg-card border border-border rounded-lg p-4">
          <h4 className="text-sm font-medium text-muted-foreground mb-4">Learning Rates</h4>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis
                dataKey="epoch"
                stroke="#9CA3AF"
                tick={{ fill: "#9CA3AF", fontSize: 12 }}
                label={{ value: "Epoch", position: "insideBottom", offset: -5, fill: "#9CA3AF" }}
                domain={[0, "dataMax"]}
              />
              <YAxis
                stroke="#9CA3AF"
                tick={{ fill: "#9CA3AF", fontSize: 12 }}
                tickFormatter={(v) => v.toExponential(1)}
              />
              <Tooltip
                contentStyle={{ backgroundColor: "#1F2937", border: "1px solid #374151", borderRadius: "6px" }}
                labelStyle={{ color: "#F3F4F6" }}
                formatter={(v: number) => v.toFixed(6)}
              />
              <Legend wrapperStyle={{ fontSize: "12px" }} />
              {data.some((m) => m.lr0) && (
                <Line type="monotone" dataKey="lr0" stroke="#3B82F6" name="LR (pg0)" strokeWidth={2} dot={{ r: 3 }} />
              )}
              {data.some((m) => m.lr1) && (
                <Line type="monotone" dataKey="lr1" stroke="#10B981" name="LR (pg1)" strokeWidth={2} dot={{ r: 3 }} />
              )}
              {data.some((m) => m.lr2) && (
                <Line type="monotone" dataKey="lr2" stroke="#F59E0B" name="LR (pg2)" strokeWidth={2} dot={{ r: 3 }} />
              )}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
