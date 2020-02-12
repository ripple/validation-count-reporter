import "reflect-metadata";
import {createConnection} from "typeorm";
import { Network } from "./collector";

createConnection().then(async connection => {

  const network = new Network('mainnet');
  network.onUnlData = (data) => {
    console.log(data);
  };
  network.onValidationReceived = (validation) => {
    console.log(validation);
  };
  await network.connect();

}).catch(error => console.log(error));
