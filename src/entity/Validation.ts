import {Entity, PrimaryColumn, Column, ManyToOne, ManyToMany, CreateDateColumn} from "typeorm";
import {Validator} from "./Validator";
import {Amendment} from "./Amendment";

@Entity()
export class Validation {

    @ManyToMany(type => Amendment, amendment => amendment.validations)
    amendments: Amendment[];

    @Column({
        nullable: true
    })
    base_fee: number // Integer

    @PrimaryColumn()
    flags: number // PK

    @PrimaryColumn()
    full: boolean;

    @PrimaryColumn()
    ledger_hash: string; // PK

    @PrimaryColumn()
    ledger_index: string; // PK

    @Column({
        nullable: true
    })
    load_fee: number; // Integer

    @Column({
        nullable: true
    })
    reserve_base: number; // Integer

    @Column({
        nullable: true
    })
    reserve_inc: number; // Integer

    @PrimaryColumn()
    signature: string; // PK

    @PrimaryColumn()
    signing_time: number; // PK

    @PrimaryColumn()
    validation_public_key: string; // PK

    @ManyToOne(type => Validator, validator => validator.validations)
    validator: Validator;

    @CreateDateColumn({
        type: "datetime",
        default: () => "CURRENT_TIMESTAMP"
    })
    created_at: Date;
}
