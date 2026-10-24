import { simulationScenarios } from './scene-data';
import './simulation-controls.css';

/** Local synthetic profiles, independent of site settings and API records. */
export default function SimulationControls({ scenarioId, onChange }) {
  const scenario = simulationScenarios.find(item => item.id === scenarioId) ?? simulationScenarios[0];
  return <section className="simulation-controls" aria-label="模拟场景选择">
    <label>模拟场景<select aria-label="模拟场景" value={scenario.id} onChange={event => onChange(event.target.value)}>
      {simulationScenarios.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
    </select><span>合成数据</span></label>
    <p aria-live="polite">{scenario.description}</p>
  </section>;
}
