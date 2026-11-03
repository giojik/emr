import type { ModulesService } from './modules';

/**
 * ModulesService-ის მიმართვა DI-ს გარეშე ფუნქციებისთვის (worklist-common და სხვ.) — ModulesService თავად აყენებს.
 * არ არის (CLI / სკრიპტი) — გამომძახებელი ბაზის enabled-ს იყენებს.
 */
export const modulesRef: { svc?: ModulesService } = {};
