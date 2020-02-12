import {Entity, PrimaryColumn, ManyToOne} from "typeorm";
import {Validator} from "./Validator";

@Entity()
export class Manifest {

  @PrimaryColumn()
  master_key: string; // PK

  @PrimaryColumn()
  signing_key: string; // PK

  @PrimaryColumn()
  seq: number; // UInt // PK

  @PrimaryColumn()
  signature: string; // PK

  @PrimaryColumn()
  master_signature: string; // PK

  @ManyToOne(type => Validator, validator => validator.manifests)
  validator: Validator;
}
