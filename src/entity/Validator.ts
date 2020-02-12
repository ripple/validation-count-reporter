import {Entity, Column, PrimaryColumn, OneToMany} from "typeorm";
import {Validation} from "./Validation";
import {Manifest} from "./Manifest";

@Entity()
export class Validator {

  @PrimaryColumn()
  validation_public_key_base58: string;

  @Column()
  signing_key: string;

  @Column()
  name: string;

  @OneToMany(type => Manifest, manifest => manifest.validator)
  manifests: Manifest[];

  @OneToMany(type => Validation, validation => validation.validator)
  validations: Validation[];
}
