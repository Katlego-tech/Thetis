import { App } from "aws-cdk-lib";
import { createStacks } from "../lib/app.ts";

const app = new App();
createStacks(app);
app.synth();
