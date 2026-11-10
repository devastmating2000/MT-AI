// The browser demo never calls a language model: the agents run on their deterministic rules.
export const llmAvailable = () => false;
export const llmStatus = () => ({ enabled: false, model: '' });
export async function askStructured(): Promise<null> { return null; }
